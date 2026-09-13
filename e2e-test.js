/* 端到端：异常发现 → 自动分级 → 唯一待办 → 领取 → 提交 → 驳回 → 再提交 → 复查销项，
   外加幂等、越权、同人复查、超时升级、规则管理、原子写。 */
const BASE = 'http://localhost:3912';
let pass = 0, fail = 0;

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

async function req(method, path, user, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (user) headers['x-user-id'] = user;
  const res = await fetch(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const U = { admin: 'u-chen', surveyorA: 'u-shen', surveyorB: 'u-luo', reviewerA: 'u-yan', reviewerB: 'u-zhi' };

async function main() {
  // 0. 迁移：种子异常巡测应已补建一份待办并自动分级
  let db = (await req('GET', '/api/db')).json;
  ok('迁移补建种子待办（异常只一份）', db.todos.filter(t => t.surveyId === 'survey-seed-1').length === 1);
  ok('种子巡测自动分级为中/高', ['中', '高'].includes(db.surveys.find(s => s.id === 'survey-seed-1').grade));
  const seedTodo = db.todos.find(t => t.surveyId === 'survey-seed-1');
  ok('种子待办初始状态为待处理', seedTodo.status === '待处理' && seedTodo.stage === 'pending');
  ok('种子待办有审计轨迹（自动生成事件）', seedTodo.events.length >= 1 && seedTodo.events[0].type === 'created');

  // 1. 未登录拒绝
  let r = await req('POST', '/api/surveys', null, {});
  ok('未登录保存巡测 → 401', r.status === 401);

  // 2. 管理员建样点（四项基准）
  r = await req('POST', '/api/sites', U.admin, {
    cave: '测试洞', zone: '甲区', pointCode: 'T-01', route: '东线',
    sensitivity: '中', baselineTemp: 16, baselineHumidity: 90, baselineCo2: 600, baselineDrip: 10
  });
  ok('管理员创建样点 201', r.status === 201, r.json?.error);
  const siteId = r.json.id;

  // 3. 正常巡测 → 不建待办
  const normalToken = 'tok-normal-1';
  r = await req('POST', '/api/surveys', U.surveyorA, {
    siteId, surveyor: '沈宁', date: '2026-09-13',
    temperature: 16.2, humidity: 90, co2: 610, dripRate: 10, disturbance: '', clientToken: normalToken
  });
  ok('正常巡测 201 且无待办', r.status === 201 && r.json.survey.grade === '正常' && r.json.todo === null, r.json?.error);
  const normalId = r.json.survey.id;

  // 4. 同 token 重复提交 → 幂等返回同一记录，不新增
  r = await req('POST', '/api/surveys', U.surveyorA, {
    siteId, surveyor: '沈宁', date: '2026-09-13',
    temperature: 16.2, humidity: 90, co2: 610, dripRate: 10, clientToken: normalToken
  });
  ok('同 token 重复提交幂等', r.status === 200 && r.json.duplicate === true && r.json.survey.id === normalId);
  db = (await req('GET', '/api/db')).json;
  ok('幂等提交未产生第二条巡测', db.surveys.filter(s => s.clientToken === normalToken).length === 1);

  // 5. 同人同天同样点无 token 再交 → 409
  r = await req('POST', '/api/surveys', U.surveyorA, {
    siteId, surveyor: '沈宁', date: '2026-09-13',
    temperature: 16.3, humidity: 90, co2: 610, dripRate: 10, clientToken: 'tok-normal-2'
  });
  ok('同人同天同样点重复登记 → 409', r.status === 409);

  // 6. 异常巡测（CO2 +450 → 高；温度 +0.9 → 中；取高）
  r = await req('POST', '/api/surveys', U.surveyorB, {
    siteId, surveyor: '骆岑', date: '2026-09-12',
    temperature: 16.9, humidity: 90, co2: 1050, dripRate: 10,
    disturbance: '', clientToken: 'tok-bad-1'
  });
  ok('异常巡测自动分级为高', r.status === 201 && r.json.survey.grade === '高' && r.json.todo, r.json?.error);
  const surveyId = r.json.survey.id;
  const todoId = r.json.todo.id;
  ok('待办含四项实测与基准审计依据', r.json.survey.gradeReasons.some(x => x.key === 'co2' && x.level === '高'));
  ok('高风险时限 24h', Math.abs(new Date(r.json.todo.deadline) - new Date(r.json.todo.createdAt) - 24 * 3600000) < 2000);

  // 同 token 重交不产生第二份待办
  r = await req('POST', '/api/surveys', U.surveyorB, {
    siteId, surveyor: '骆岑', date: '2026-09-12',
    temperature: 16.9, humidity: 90, co2: 950, dripRate: 10, clientToken: 'tok-bad-1'
  });
  ok('异常重复提交返回同一待办', r.json.duplicate === true && r.json.todo.id === todoId);
  db = (await req('GET', '/api/db')).json;
  ok('一条异常只有一份待办', db.todos.filter(t => t.surveyId === surveyId).length === 1);

  // 7. 越权：复查员/管理员不能领取
  r = await req('POST', `/api/todos/${todoId}/claim`, U.reviewerA, {});
  ok('复查员领取 → 403', r.status === 403);
  r = await req('POST', `/api/todos/${todoId}/claim`, U.admin, {});
  ok('管理员领取 → 403', r.status === 403);

  // 8. 巡测员A领取
  r = await req('POST', `/api/todos/${todoId}/claim`, U.surveyorA, { clientToken: 'c-1' });
  ok('巡测员A领取成功', r.status === 200 && r.json.todo.handlerId === U.surveyorA && r.json.todo.stage === 'handling');
  // 巡测员B并发/重复领取 → 409
  r = await req('POST', `/api/todos/${todoId}/claim`, U.surveyorB, { clientToken: 'c-2' });
  ok('他人重复领取 → 409', r.status === 409);
  // A 再领取 → 幂等
  r = await req('POST', `/api/todos/${todoId}/claim`, U.surveyorA, { clientToken: 'c-3' });
  ok('本人重复领取幂等', r.status === 200 && r.json.duplicate === true);

  // 9. 未领取者不能提交；B 提交 → 403
  r = await req('POST', `/api/todos/${todoId}/submit-handling`, U.surveyorB, { note: '我处理了' });
  ok('非处理人提交 → 403', r.status === 403);
  // 空说明 → 400
  r = await req('POST', `/api/todos/${todoId}/submit-handling`, U.surveyorA, { note: '' });
  ok('空处理说明 → 400', r.status === 400);

  // 10. A 提交复查；同 token 重交幂等
  r = await req('POST', `/api/todos/${todoId}/submit-handling`, U.surveyorA, { note: '现场通风并围挡', clientToken: 's-1' });
  ok('处理人提交复查成功', r.status === 200 && r.json.todo.stage === 'review' && r.json.todo.status === '待复查');
  r = await req('POST', `/api/todos/${todoId}/submit-handling`, U.surveyorA, { note: '现场通风并围挡', clientToken: 's-1' });
  ok('提交复查重复请求幂等', r.status === 200 && r.json.duplicate === true);
  // 再次提交 → 409
  r = await req('POST', `/api/todos/${todoId}/submit-handling`, U.surveyorA, { note: '再交一次', clientToken: 's-2' });
  ok('复查中重复提交 → 409', r.status === 409);

  // 11. 巡测员不能驳回/销项
  r = await req('POST', `/api/todos/${todoId}/reject`, U.surveyorA, { reason: '不行' });
  ok('巡测员驳回 → 403', r.status === 403);
  r = await req('POST', `/api/todos/${todoId}/close`, U.surveyorA, { note: '销项' });
  ok('巡测员销项 → 403', r.status === 403);

  // 12. 复查员A 驳回
  r = await req('POST', `/api/todos/${todoId}/reject`, U.reviewerA, { reason: 'CO2仍偏高，复测', clientToken: 'j-1' });
  ok('复查员驳回成功', r.status === 200 && r.json.todo.stage === 'handling' && r.json.todo.status === '已驳回');
  // 同 token 重复驳回幂等
  r = await req('POST', `/api/todos/${todoId}/reject`, U.reviewerA, { reason: 'CO2仍偏高，复测', clientToken: 'j-1' });
  ok('重复驳回幂等', r.status === 200 && r.json.duplicate === true);
  // 驳回态不能再驳回
  r = await req('POST', `/api/todos/${todoId}/reject`, U.reviewerA, { reason: '再驳回', clientToken: 'j-2' });
  ok('非复查阶段驳回 → 409', r.status === 409);
  // 驳回后只有原处理人A能继续；B 提交 → 403
  r = await req('POST', `/api/todos/${todoId}/submit-handling`, U.surveyorB, { note: 'B来处理' });
  ok('驳回后非原处理人提交 → 403', r.status === 403);

  // 13. A 重新处理提交
  r = await req('POST', `/api/todos/${todoId}/submit-handling`, U.surveyorA, { note: '复测CO2回落至620', clientToken: 's-3' });
  ok('驳回后处理人重新提交成功', r.status === 200 && r.json.todo.stage === 'review');

  // 14. 复查员B 销项
  r = await req('POST', `/api/todos/${todoId}/close`, U.reviewerB, { note: '指标恢复，同意销项', clientToken: 'x-1' });
  ok('复查员销项成功', r.status === 200 && r.json.todo.open === false && r.json.todo.status === '已销项');
  r = await req('POST', `/api/todos/${todoId}/close`, U.reviewerB, { note: '指标恢复，同意销项', clientToken: 'x-1' });
  ok('重复销项幂等', r.status === 200 && r.json.duplicate === true);
  r = await req('POST', `/api/todos/${todoId}/claim`, U.surveyorA, {});
  ok('已销项不能再领取 → 409', r.status === 409);
  db = (await req('GET', '/api/db')).json;
  const closedSurvey = db.surveys.find(s => s.id === surveyId);
  ok('销项后巡测同步为已复查', closedSurvey.status === '已复查' && closedSurvey.reviewNote === '指标恢复，同意销项');
  const closedTodo = db.todos.find(t => t.id === todoId);
  const types = closedTodo.events.map(e => e.type);
  ok('审计轨迹完整（发现/领取/提交/驳回/提交/销项）',
    ['created', 'claimed', 'submitted', 'rejected', 'submitted', 'closed'].every((t, i) => types[i] === t),
    types.join(','));
  ok('每步事件有操作人与时间', closedTodo.events.every(e => e.at && e.actorName));

  // 15. 管理员规则：非管理员 403；非法阈值 400；合法更新生效
  r = await req('PUT', '/api/admin/settings', U.reviewerA, { metrics: [] });
  ok('非管理员改规则 → 403', r.status === 403);
  r = await req('PUT', '/api/admin/settings', U.admin, {
    metrics: [{ key: 'co2', midDelta: 500, highDelta: 400 }]
  });
  ok('中阈值>高阈值 → 400', r.status === 400);
  r = await req('PUT', '/api/admin/settings', U.admin, {
    metrics: [{ key: 'co2', midDelta: 100, highDelta: 300 }],
    slaHours: { '中': 12, '高': 6, review: 6 },
    disturbanceAsSignal: true,
    reason: '演练收紧'
  });
  ok('管理员更新规则成功', r.status === 200 && r.json.settings.metrics.find(m => m.key === 'co2').midDelta === 100);

  // 新规则下 CO2 +150 之前是中，现在应为正常（<100 中阈值？150>=100 → 中）。用 +50 验证正常
  r = await req('POST', '/api/surveys', U.surveyorA, {
    siteId, surveyor: '沈宁', date: '2026-09-11',
    temperature: 16.1, humidity: 90, co2: 650, dripRate: 10, clientToken: 'tok-newrule'
  });
  ok('新规则：CO2偏差50不再判异', r.json.survey.grade === '正常', r.json?.error);
  // 新时限 6h 生效
  r = await req('POST', '/api/surveys', U.surveyorB, {
    siteId, surveyor: '骆岑', date: '2026-09-10',
    temperature: 16, humidity: 90, co2: 1000, dripRate: 10, clientToken: 'tok-sla'
  });
  const slaTodo = r.json.todo;
  ok('新高风险时限 6h', slaTodo && Math.abs(new Date(slaTodo.deadline) - new Date(slaTodo.createdAt) - 6 * 3600000) < 2000);

  // 16. 超时升级：手工把 deadline 调到过去，触发 GET /api/db 升级
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, 'data', 'db.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const target = raw.todos.find(t => t.id === slaTodo.id);
  target.deadline = new Date(Date.now() - 3600000).toISOString();
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  db = (await req('GET', '/api/db')).json;
  const esc = db.todos.find(t => t.id === slaTodo.id);
  ok('超时后自动升级', esc.escalated === true && esc.escalationLevel === 1 && esc.status === '已升级');
  ok('升级事件入审计轨迹', esc.events.some(e => e.type === 'escalated'));
  const escSite = db.sites.find(s => s.id === siteId);
  ok('超时升级联动样点暂停开放', escSite.protectedStatus === '暂停开放');

  // 17. 通用改写入口被封
  r = await req('PATCH', `/api/todos/${slaTodo.id}`, U.admin, { status: '已销项' });
  ok('PATCH 待办被拒绝', r.status === 403);
  r = await req('DELETE', `/api/surveys/${surveyId}`, U.admin, {});
  ok('DELETE 不提供', r.status === 404);

  // 18. 升级后的待办仍可领取并走完闭环
  r = await req('POST', `/api/todos/${slaTodo.id}/claim`, U.surveyorB, {});
  ok('升级待办可领取', r.status === 200 && r.json.todo.handlerId === U.surveyorB);
  r = await req('POST', `/api/todos/${slaTodo.id}/submit-handling`, U.surveyorB, { note: '处置完成' });
  ok('升级待办可提交复查', r.status === 200 && r.json.todo.stage === 'review');
  r = await req('POST', `/api/todos/${slaTodo.id}/close`, U.reviewerA, { note: '复核通过' });
  ok('升级待办可销项，闭环结束', r.status === 200 && r.json.todo.open === false);

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
