const express = require('express');
const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const config = require('./project.config');
const PORT = process.env.PORT || config.port || 3900;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const LEVEL_RANK = { 正常: 0, 中: 1, 高: 2 };
const OPEN_STATUSES = ['待处理', '处理中', '待复查', '已驳回', '已升级'];

const DEFAULT_SETTINGS = {
  metrics: [
    { key: 'temperature', label: '温度', unit: '℃', baselineField: 'baselineTemp', measuredField: 'temperature', midDelta: 0.8, highDelta: 1.5 },
    { key: 'humidity', label: '湿度', unit: '%', baselineField: 'baselineHumidity', measuredField: 'humidity', midDelta: 5, highDelta: 10 },
    { key: 'co2', label: 'CO2', unit: 'ppm', baselineField: 'baselineCo2', measuredField: 'co2', midDelta: 200, highDelta: 400 },
    { key: 'dripRate', label: '滴水频率', unit: '滴/分', baselineField: 'baselineDrip', measuredField: 'dripRate', midDelta: 5, highDelta: 10 }
  ],
  disturbanceAsSignal: true,
  slaHours: { '中': 48, '高': 24, review: 24 }
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function addHours(iso, hours) {
  return new Date(new Date(iso).getTime() + Number(hours) * 3600000).toISOString();
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/* ---------- 身份 ---------- */

app.use((req, res, next) => {
  const userId = req.header('x-user-id');
  req.user = config.users.find((user) => user.id === userId) || null;
  next();
});

function requireUser(req) {
  if (!req.user) throw new HttpError(401, '未选择身份，请先在页面顶部选择操作人员');
  return req.user;
}

function requireRole(req, ...roles) {
  const user = requireUser(req);
  if (!roles.includes(user.role)) throw new HttpError(403, '越权操作：当前身份无权执行此操作');
  return user;
}

/* ---------- 存储：读 + 原子写（写串行，tmp+rename，失败不留半成品） ---------- */

let writeChain = Promise.resolve();
let tmpSeq = 0;

async function readRawDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function atomicWrite(db) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.${process.pid}.${tmpSeq++}.tmp`;
  const payload = JSON.stringify(db, null, 2) + '\n';
  try {
    await fs.writeFile(tmp, payload, { flag: 'wx' });
    await fs.rename(tmp, DB_FILE);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

function persist(db) {
  const job = writeChain.then(() => atomicWrite(db));
  // 写失败不冲掉后续任务的串行链，且错误由调用方感知
  writeChain = job.catch(() => {});
  return job;
}

// 变更互斥：所有"读-改-写"事务串行执行，并发领取/提交只有一人成功
let txChain = Promise.resolve();
function withTx(worker) {
  const run = txChain.then(async () => {
    const db = await readRawDb();
    return worker(db);
  });
  txChain = run.then(() => {}, () => {});
  return run;
}

function stamp(action, note, actor) {
  return { at: nowIso(), action, note: note || '', actor: actor ? `${actor.name}(${actor.title})` : '' };
}

function todoEvent(type, action, actor, detail = '') {
  return {
    at: nowIso(),
    type,
    action,
    actorId: actor?.id || 'system',
    actorName: actor?.name || '系统',
    detail
  };
}

/* ---------- 设置与分级 ---------- */

function getSettings(db) {
  const saved = db.settings || {};
  const metrics = DEFAULT_SETTINGS.metrics.map((def) => {
    const found = (saved.metrics || []).find((item) => item.key === def.key);
    return { ...def, ...(found || {}) };
  });
  return {
    metrics,
    disturbanceAsSignal: saved.disturbanceAsSignal !== undefined ? !!saved.disturbanceAsSignal : DEFAULT_SETTINGS.disturbanceAsSignal,
    slaHours: { ...DEFAULT_SETTINGS.slaHours, ...(saved.slaHours || {}) }
  };
}

function gradeSurvey(site, survey, settings) {
  const reasons = [];
  let rank = 0;
  for (const metric of settings.metrics) {
    const baseline = Number(site?.[metric.baselineField]);
    const measured = Number(survey[metric.measuredField]);
    if (!Number.isFinite(baseline) || !Number.isFinite(measured)) continue;
    const delta = round1(Math.abs(measured - baseline));
    let level = null;
    if (delta >= Number(metric.highDelta)) level = '高';
    else if (delta >= Number(metric.midDelta)) level = '中';
    if (level) {
      rank = Math.max(rank, LEVEL_RANK[level]);
      reasons.push({ key: metric.key, label: metric.label, unit: metric.unit, baseline, measured, delta, level });
    }
  }
  if (settings.disturbanceAsSignal && String(survey.disturbance || '').trim()) {
    rank = Math.max(rank, LEVEL_RANK['中']);
    reasons.push({ key: 'disturbance', label: '游客干扰痕迹', level: '中', detail: String(survey.disturbance).trim() });
  }
  const grade = rank >= LEVEL_RANK['高'] ? '高' : rank === LEVEL_RANK['中'] ? '中' : '正常';
  return { grade, reasons };
}

/* ---------- 待办工厂 ---------- */

function createTodoFromSurvey(survey, site, settings, actor) {
  const ts = nowIso();
  const reasonsText = (survey.gradeReasons || [])
    .map((reason) => reason.detail || `${reason.label}偏离基准${reason.delta ?? ''}${reason.unit ? reason.unit : ''}（${reason.level}）`)
    .join('；');
  return {
    id: `todo-${crypto.randomUUID().slice(0, 8)}`,
    surveyId: survey.id,
    siteId: survey.siteId,
    siteLabel: site ? [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ') : '',
    surveyor: survey.surveyor,
    grade: survey.grade,
    status: '待处理',
    stage: 'pending', // pending -> handling -> review -> done
    open: true,
    handlerId: null,
    handlerName: null,
    handledAt: null,
    handlerNote: '',
    reviewerId: null,
    reviewerName: null,
    reviewedAt: null,
    reviewNote: '',
    rejection: null,
    createdAt: ts,
    updatedAt: ts,
    claimedAt: null,
    submittedAt: null,
    closedAt: null,
    deadline: addHours(ts, settings.slaHours[survey.grade] ?? settings.slaHours['中']),
    escalated: false,
    escalationLevel: 0,
    usedTokens: [],
    events: [todoEvent('created', '异常发现', actor, `按样点基准自动分级为【${survey.grade}】；${reasonsText}`)]
  };
}

/* ---------- 超时升级（读/写路径都会先执行一次） ---------- */

function applyEscalations(db, settings) {
  const ts = nowIso();
  let changed = false;
  for (const todo of db.todos || []) {
    if (!todo.open || !todo.deadline || new Date(todo.deadline).getTime() >= Date.now()) continue;
    const windowHours = todo.stage === 'review'
      ? settings.slaHours.review
      : settings.slaHours[todo.grade] ?? settings.slaHours['中'];
    todo.escalated = true;
    todo.escalationLevel = (todo.escalationLevel || 0) + 1;
    todo.status = '已升级';
    todo.deadline = addHours(ts, windowHours);
    todo.updatedAt = ts;
    todo.events.push(todoEvent('escalated', '自动升级', null,
      `超过处理时限（第${todo.escalationLevel}次），时限顺延${windowHours}小时`));
    const site = db.sites.find((entry) => entry.id === todo.siteId);
    if (site && site.protectedStatus !== '暂停开放') {
      site.protectedStatus = '暂停开放';
      site.updatedAt = ts;
      site.history = site.history || [];
      site.history.unshift(stamp('超时升级', `待办${todo.id}超时，样点暂停开放`));
    }
    changed = true;
  }
  return changed;
}

/* ---------- 启动迁移：中断恢复，补齐历史数据 ---------- */

async function migrate() {
  let db;
  try {
    db = await readRawDb();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    db = { sites: [], surveys: [], todos: [] };
  }
  db.sites = db.sites || [];
  db.surveys = db.surveys || [];
  db.todos = db.todos || [];
  if (!db.settings || typeof db.settings !== 'object') db.settings = {};

  let changed = false;
  for (const site of db.sites) {
    if (site.baselineDrip === undefined) {
      site.baselineDrip = 10;
      changed = true;
    }
  }
  // 中断/历史遗留：异常巡测没有对应待办时补建，保证一条异常只挂一份待办
  const settings = getSettings(db);
  for (const survey of db.surveys) {
    if (!survey.grade) {
      const site = db.sites.find((entry) => entry.id === survey.siteId);
      const result = gradeSurvey(site, survey, settings);
      survey.grade = result.grade;
      survey.gradeReasons = result.reasons;
      if (!survey.status) survey.status = result.grade === '正常' ? '正常' : '异常待复查';
      changed = true;
    }
    if (survey.status === '异常待复查' && !db.todos.some((todo) => todo.surveyId === survey.id)) {
      db.todos.push(createTodoFromSurvey(survey, db.sites.find((entry) => entry.id === survey.siteId), settings));
      changed = true;
    }
  }
  if (changed) await atomicWrite(db);
  return db;
}

/* ---------- 查询 ---------- */

app.get('/api/config', (req, res) => {
  res.json({ ...config, currentUser: req.user || null });
});

app.get('/api/settings', (req, res) => {
  readRawDb().then((db) => {
    res.json({ settings: getSettings(db || {}) });
  }).catch(() => res.json({ settings: getSettings({}) }));
});

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

function sortTodos(a, b) {
  if (a.open !== b.open) return a.open ? -1 : 1;
  if (a.open && b.open) return new Date(a.deadline || 0) - new Date(b.deadline || 0);
  return sortNewest(a, b);
}

app.get('/api/db', async (req, res, next) => {
  try {
    const db = await withTx(async (txDb) => {
      txDb.sites = txDb.sites || [];
      txDb.surveys = txDb.surveys || [];
      txDb.todos = txDb.todos || [];
      // 读路径触发超时升级；升级在事务内原子落盘，失败则本次仅返回升级后的视图，下次读取重试
      if (applyEscalations(txDb, getSettings(txDb))) {
        try { await persist(txDb); } catch (error) { console.error('升级落盘失败，将在下次重试：', error.message); }
      }
      for (const key of Object.keys(txDb)) {
        if (!Array.isArray(txDb[key])) continue;
        txDb[key].sort(key === 'todos' ? sortTodos : sortNewest);
      }
      return txDb;
    });
    res.json(db);
  } catch (error) {
    next(error);
  }
});

/* ---------- 样点（沿用通用保存，仅允许已登录人员） ---------- */

app.post('/api/sites', async (req, res, next) => {
  try {
    const actor = requireUser(req);
    const body = req.body || {};
    for (const field of ['cave', 'zone', 'pointCode', 'route']) {
      if (!String(body[field] || '').trim()) throw new HttpError(400, `缺少必填项：${field}`);
    }
    for (const field of ['baselineTemp', 'baselineHumidity', 'baselineCo2', 'baselineDrip']) {
      if (!Number.isFinite(Number(body[field]))) throw new HttpError(400, '基准值必须是数字');
    }
    const item = await withTx(async (db) => {
      const ts = nowIso();
      const created = {
        id: `site-${crypto.randomUUID().slice(0, 8)}`,
        ...body,
        baselineTemp: Number(body.baselineTemp),
        baselineHumidity: Number(body.baselineHumidity),
        baselineCo2: Number(body.baselineCo2),
        baselineDrip: Number(body.baselineDrip),
        protectedStatus: body.protectedStatus || '常规观察',
        createdAt: ts,
        updatedAt: ts,
        history: [stamp('创建', body.note || '样点建档', actor)]
      };
      db.sites.push(created);
      await persist(db);
      return created;
    });
    res.status(201).json(item);
  } catch (error) {
    next(error);
  }
});

/* ---------- 巡测保存：自动分级 + 同一原子写入内生成唯一待办 ---------- */

app.post('/api/surveys', async (req, res, next) => {
  try {
    const actor = requireUser(req);
    const body = req.body || {};

    if (!body.siteId) throw new HttpError(400, '请选择样点');
    if (!String(body.surveyor || '').trim()) throw new HttpError(400, '请填写巡测人员');
    if (!body.date) throw new HttpError(400, '请选择日期');
    for (const field of ['temperature', 'humidity', 'co2', 'dripRate']) {
      if (!Number.isFinite(Number(body[field]))) throw new HttpError(400, '四项实测值必须是数字');
    }

    const result = await withTx(async (db) => {
      const settings = getSettings(db);

      // 幂等：相同 clientToken 的重复提交直接返回首次结果，不重复流转
      const clientToken = String(body.clientToken || '').trim();
      if (clientToken) {
        const existing = db.surveys.find((survey) => survey.clientToken === clientToken);
        if (existing) {
          return { duplicate: true, survey: existing, todo: db.todos.find((todo) => todo.surveyId === existing.id) || null };
        }
      }
      // 同人同天同样点重复登记拦截
      const dup = db.surveys.find((survey) =>
        survey.siteId === body.siteId && survey.date === body.date && survey.surveyor === body.surveyor);
      if (dup) throw new HttpError(409, '重复提交：该样点当天已有同一巡测员的记录');

      const site = db.sites.find((entry) => entry.id === body.siteId);
      if (!site) throw new HttpError(400, '样点不存在');

      const ts = nowIso();
      const surveyInput = {
        siteId: body.siteId,
        surveyor: String(body.surveyor).trim(),
        date: body.date,
        temperature: Number(body.temperature),
        humidity: Number(body.humidity),
        co2: Number(body.co2),
        dripRate: Number(body.dripRate),
        disturbance: String(body.disturbance || '').trim(),
        photoUrl: String(body.photoUrl || '').trim()
      };
      const { grade, reasons } = gradeSurvey(site, surveyInput, settings);

      const survey = {
        id: `survey-${crypto.randomUUID().slice(0, 8)}`,
        ...surveyInput,
        clientToken: clientToken || undefined,
        grade,
        gradeReasons: reasons,
        status: grade === '正常' ? '正常' : '异常待复查',
        reviewNote: '',
        createdAt: ts,
        updatedAt: ts,
        history: [stamp('保存巡测', grade === '正常' ? '自动分级：正常' : `自动分级：${grade}异常`, actor)]
      };
      db.surveys.push(survey);

      let todo = null;
      if (grade !== '正常') {
        todo = createTodoFromSurvey(survey, site, settings, actor);
        db.todos.push(todo);
        if (site.protectedStatus === '常规观察' || !site.protectedStatus) {
          site.protectedStatus = '重点保护';
          site.updatedAt = ts;
          site.history = site.history || [];
          site.history.unshift(stamp('异常发现', `巡测${survey.surveyor}上报${grade}异常，转入重点保护`, actor));
        }
      }

      // 巡测与待办同一次原子写入：写入失败则整体不可见，不存在半成品
      await persist(db);
      return { survey, todo };
    });

    if (result.duplicate) return res.json(result);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

/* ---------- 待办流转 ---------- */

// 在事务上下文中取出待办并执行超时升级
function todoInTx(db, id) {
  const settings = getSettings(db);
  applyEscalations(db, settings);
  const todo = db.todos.find((entry) => entry.id === id);
  if (!todo) throw new HttpError(404, '待办不存在');
  const survey = db.surveys.find((entry) => entry.id === todo.surveyId) || null;
  const site = db.sites.find((entry) => entry.id === todo.siteId) || null;
  return { settings, todo, survey, site };
}

// 请求标记只在「同一人 + 同一动作」内识别为重复；
// 同一标记被其他角色或其他动作复用时，视为冲突请求并拒绝，不做状态流转
function checkToken(todo, token, action, actorId) {
  const key = String(token || '').trim();
  if (!key) return { replay: false, stolen: false };
  const record = (todo.usedTokens || []).find((entry) => entry && entry.token === key);
  if (!record) return { replay: false, stolen: false };
  if (record.action === action && record.actorId === actorId) return { replay: true, stolen: false };
  return { replay: false, stolen: true, record };
}

function rememberToken(todo, token, action, actorId) {
  const key = String(token || '').trim();
  if (!key) return;
  todo.usedTokens = todo.usedTokens || [];
  if (!todo.usedTokens.some((entry) => entry.token === key)) {
    todo.usedTokens.push({ token: key, action, actorId });
  }
}

function rejectStolenToken(result, action) {
  if (result.stolen) {
    throw new HttpError(409, `该请求标记已用于「${result.record.action}」操作，禁止复用到其他角色或动作`);
  }
}

app.post('/api/todos/:id/claim', async (req, res, next) => {
  try {
    const actor = requireRole(req, 'surveyor');
    const result = await withTx(async (db) => {
      const { todo } = todoInTx(db, req.params.id);
      const dup = checkToken(todo, req.body?.clientToken, 'claim', actor.id);
      rejectStolenToken(dup, 'claim');
      if (!todo.open) throw new HttpError(409, '待办已销项，无需处理');

      // 幂等：同一人重复领取直接返回当前状态
      if (todo.handlerId === actor.id && (todo.stage === 'handling' || todo.stage === 'review')) {
        return { duplicate: true, todo };
      }
      if (todo.handlerId && todo.stage === 'handling') {
        throw new HttpError(409, `待办已由【${todo.handlerName}】领取，不能重复领取`);
      }
      if (todo.stage === 'review') throw new HttpError(409, '待办已提交复查，等待复查员处理');

      todo.handlerId = actor.id;
      todo.handlerName = actor.name;
      todo.claimedAt = nowIso();
      todo.stage = 'handling';
      todo.status = todo.escalated ? '已升级' : '处理中';
      todo.updatedAt = nowIso();
      todo.events.push(todoEvent('claimed', '领取处理', actor));
      rememberToken(todo, req.body?.clientToken, 'claim', actor.id);
      await persist(db);
      return { todo };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/todos/:id/submit-handling', async (req, res, next) => {
  try {
    const actor = requireRole(req, 'surveyor');
    const note = String(req.body?.note || '').trim();
    if (!note) throw new HttpError(400, '请填写现场处理说明');
    const result = await withTx(async (db) => {
      const { todo, settings } = todoInTx(db, req.params.id);

      const dup = checkToken(todo, req.body?.clientToken, 'submit', actor.id);
      rejectStolenToken(dup, 'submit');
      if (dup.replay) return { duplicate: true, todo };
      if (!todo.open) throw new HttpError(409, '待办已销项');
      if (todo.handlerId !== actor.id) {
        throw new HttpError(403, `越权操作：该待办由【${todo.handlerName || '他人'}】负责处理`);
      }
      if (todo.stage === 'review') throw new HttpError(409, '已提交复查，请勿重复提交');
      if (todo.stage === 'pending') throw new HttpError(409, '请先领取待办再提交处理结果');

      const ts = nowIso();
      todo.handlerNote = note;
      todo.handledAt = ts;
      todo.stage = 'review';
      todo.status = '待复查';
      todo.submittedAt = ts;
      todo.deadline = addHours(ts, settings.slaHours.review);
      todo.updatedAt = ts;
      todo.events.push(todoEvent('submitted', '提交复查', actor, note));
      rememberToken(todo, req.body?.clientToken, 'submit', actor.id);
      await persist(db);
      return { todo };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/todos/:id/reject', async (req, res, next) => {
  try {
    const actor = requireRole(req, 'reviewer');
    const reason = String(req.body?.reason || '').trim();
    if (!reason) throw new HttpError(400, '请填写驳回原因');
    const result = await withTx(async (db) => {
      const { todo, settings } = todoInTx(db, req.params.id);

      const dup = checkToken(todo, req.body?.clientToken, 'reject', actor.id);
      rejectStolenToken(dup, 'reject');
      if (dup.replay) return { duplicate: true, todo };
      if (!todo.open) throw new HttpError(409, '待办已销项');
      if (todo.stage !== 'review') throw new HttpError(409, '仅待复查状态可以驳回');
      if (todo.handlerId === actor.id) throw new HttpError(403, '不能驳回自己提交的处理结果');

      const ts = nowIso();
      todo.stage = 'handling';
      todo.status = '已驳回';
      todo.rejection = { by: actor.name, at: ts, reason };
      todo.reviewerId = actor.id;
      todo.reviewerName = actor.name;
      todo.deadline = addHours(ts, settings.slaHours[todo.grade] ?? settings.slaHours['中']);
      todo.updatedAt = ts;
      todo.events.push(todoEvent('rejected', '复查驳回', actor,
        `退回处理人【${todo.handlerName}】继续处理：${reason}`));
      rememberToken(todo, req.body?.clientToken, 'reject', actor.id);
      await persist(db);
      return { todo };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/todos/:id/close', async (req, res, next) => {
  try {
    const actor = requireRole(req, 'reviewer');
    const note = String(req.body?.note || '').trim();
    if (!note) throw new HttpError(400, '请填写复查结论');
    const result = await withTx(async (db) => {
      const { todo, survey, site } = todoInTx(db, req.params.id);

      const dup = checkToken(todo, req.body?.clientToken, 'close', actor.id);
      rejectStolenToken(dup, 'close');
      if (dup.replay) return { duplicate: true, todo };
      if (!todo.open) throw new HttpError(409, '待办已销项，请勿重复操作');
      if (todo.stage !== 'review') throw new HttpError(409, '处理人尚未提交复查');
      if (todo.handlerId === actor.id) {
        throw new HttpError(403, '复查人与处理人不能为同一人，请由另一名复查员销项');
      }

      const ts = nowIso();
      todo.stage = 'done';
      todo.status = '已销项';
      todo.open = false;
      todo.escalated = false;
      todo.reviewerId = actor.id;
      todo.reviewerName = actor.name;
      todo.reviewedAt = ts;
      todo.reviewNote = note;
      todo.closedAt = ts;
      todo.deadline = null;
      todo.updatedAt = ts;
      todo.events.push(todoEvent('closed', '复查销项', actor, note));
      if (survey) {
        survey.status = '已复查';
        survey.reviewNote = note;
        survey.updatedAt = ts;
        survey.history = survey.history || [];
        survey.history.unshift(stamp('复查销项', `${actor.name}：${note}`, actor));
      }
      if (site && site.protectedStatus === '暂停开放' && !db.todos.some((other) => other.open && other.siteId === site.id && other.id !== todo.id)) {
        // 该样点没有其他未结待办时解除暂停
        site.protectedStatus = '重点保护';
        site.updatedAt = ts;
        site.history = site.history || [];
        site.history.unshift(stamp('恢复开放', '关联待办全部销项', actor));
      }
      rememberToken(todo, req.body?.clientToken, 'close', actor.id);
      await persist(db);
      return { todo };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/* ---------- 管理员：判定规则 ---------- */

app.put('/api/admin/settings', async (req, res, next) => {
  try {
    const actor = requireRole(req, 'admin');
    const body = req.body || {};
    const settings = await withTx(async (db) => {
      const current = getSettings(db);

      const incomingMetrics = Array.isArray(body.metrics) ? body.metrics : [];
      const metrics = current.metrics.map((def) => {
        const patch = incomingMetrics.find((item) => item && item.key === def.key);
        if (!patch) return def;
        const midDelta = Number(patch.midDelta);
        const highDelta = Number(patch.highDelta);
        if (![midDelta, highDelta].every((value) => Number.isFinite(value) && value >= 0) || highDelta < midDelta) {
          throw new HttpError(400, `${def.label}阈值无效：需满足 0 ≤ 中偏差 ≤ 高偏差`);
        }
        return { ...def, midDelta, highDelta };
      });

      const slaIn = body.slaHours || {};
      const slaHours = { ...current.slaHours };
      for (const key of ['中', '高', 'review']) {
        if (slaIn[key] !== undefined) {
          const value = Number(slaIn[key]);
          if (!Number.isInteger(value) || value <= 0) throw new HttpError(400, '处理时限必须是正整数小时');
          slaHours[key] = value;
        }
      }

      db.settings = {
        ...(db.settings || {}),
        metrics,
        disturbanceAsSignal: body.disturbanceAsSignal !== undefined ? !!body.disturbanceAsSignal : current.disturbanceAsSignal,
        slaHours,
        updatedAt: nowIso(),
        history: [
          ...(db.settings.history || []),
          stamp('规则调整', body.reason ? `原因：${body.reason}` : '管理员更新分级阈值与处理时限', actor)
        ]
      };
      await persist(db);
      return getSettings(db);
    });
    res.json({ settings });
  } catch (error) {
    next(error);
  }
});

/* ---------- 样点状态动作（保留原配置驱动能力，仅作用于样点） ---------- */

app.post('/api/action/:actionId/:id', async (req, res, next) => {
  try {
    const actor = requireUser(req);
    const item = await withTx(async (db) => {
      const action = config.actions.find((entry) => entry.id === req.params.actionId);
      if (!action || action.collection !== 'sites') throw new HttpError(404, '未知操作');
      const site = db.sites?.find((entry) => entry.id === req.params.id);
      if (!site) throw new HttpError(404, '未找到样点');
      for (const patch of action.patches || []) {
        site[patch.field] = patch.value;
      }
      site.updatedAt = nowIso();
      site.history = site.history || [];
      site.history.unshift(stamp(action.label, action.note || '状态调整', actor));
      await persist(db);
      return site;
    });
    res.json(item);
  } catch (error) {
    next(error);
  }
});

// 待办与巡测只能走专用端点，拒绝通用改写/删除，避免绕过状态机与审计
app.patch('/api/:collection/:id', (req, res, next) => {
  const collection = req.params.collection;
  if (collection === 'surveys' || collection === 'todos') {
    return next(new HttpError(403, '该数据需通过专用流程操作，不允许直接修改'));
  }
  next(new HttpError(404, '未提供该操作'));
});

app.delete('/api/:collection/:id', (req, res, next) => {
  next(new HttpError(404, '未提供该操作'));
});

// 通用集合写入入口（防止误把巡测/待办写到通用路径）
app.post('/api/:collection', (req, res, next) => {
  if (req.params.collection === 'surveys' || req.params.collection === 'todos') {
    return next(new HttpError(403, '请使用专用流程入口'));
  }
  next(new HttpError(404, '未知数据集合'));
});

app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = error.status || 500;
  if (status === 500) console.error(error);
  res.status(status).json({ error: error.message || '服务器错误' });
});

async function boot() {
  // 清理上次中断残留的临时文件
  try {
    const leftovers = (await fs.readdir(DATA_DIR)).filter((name) => name.endsWith('.tmp'));
    await Promise.all(leftovers.map((name) => fs.rm(path.join(DATA_DIR, name), { force: true })));
  } catch { /* 目录尚不存在时忽略 */ }
  await migrate();
  app.listen(PORT, () => {
    console.log(`${config.title} running at http://localhost:${PORT}`);
  });
}

boot().catch((error) => {
  console.error(error);
  process.exit(1);
});
