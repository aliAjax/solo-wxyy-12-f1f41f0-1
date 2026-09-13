const state = {
  config: null,
  db: {},
  settings: null,
  activeTab: '',
  todoFilter: 'open',
  modal: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

function token() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `t-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function api(path, options = {}) {
  const userId = localStorage.getItem('caveUserId') || '';
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}) },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error = new Error(body.error || '请求失败');
    error.status = res.status;
    throw error;
  }
  if (res.status === 204) return null;
  return res.json();
}

function currentUser() {
  const id = localStorage.getItem('caveUserId');
  return state.config?.users?.find((user) => user.id === id) || null;
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  return relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  const step = field.step ? `step="${field.step}"` : '';
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select></label>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${step} ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(history, limit = 5) {
  if (!history?.length) return '';
  return `<div class="history">${history.slice(0, limit).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.actor ? ` · ${escapeHtml(entry.actor)}` : ''}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

/* ---------- 身份 ---------- */

function renderIdentity() {
  const select = $('#userSelect');
  const users = state.config.users || [];
  let currentId = localStorage.getItem('caveUserId');
  if (!currentId || !users.some((user) => user.id === currentId)) {
    currentId = users[0]?.id || '';
    localStorage.setItem('caveUserId', currentId);
  }
  select.innerHTML = users.map((user) =>
    `<option value="${user.id}"${user.id === currentId ? ' selected' : ''}>${escapeHtml(user.name)} · ${escapeHtml(user.title)}</option>`).join('');
}

/* ---------- 标签页 ---------- */

function visibleViews() {
  const user = currentUser();
  return state.config.views.filter((view) => !view.adminOnly || user?.role === 'admin');
}

function renderTabs() {
  const views = visibleViews();
  $('#tabs').innerHTML = views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  if (!views.some((view) => view.id === state.activeTab)) state.activeTab = views[0]?.id || '';
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

/* ---------- 统计 ---------- */

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = stat.filter ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

/* ---------- 通用卡片（样点） ---------- */

function renderSiteCard(item, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const details = (view.detailFields || []).map((field) => {
    const raw = item[field.name];
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(raw ?? '-')}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  const actions = state.config.actions
    .filter((action) => action.collection === 'sites')
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    ${historyHtml(item.history)}
  </article>`;
}

/* ---------- 巡测卡片 ---------- */

function renderSurveyCard(item) {
  const view = state.config.views.find((entry) => entry.id === 'surveys');
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const site = relationLabel(view.relation, item.siteId);
  const details = view.detailFields.map((field) =>
    `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(item[field.name] ?? '-')}</strong></div>`).join('');
  const reasons = (item.gradeReasons || []).map((reason) =>
    reason.detail
      ? `${reason.label}：${reason.detail}（${reason.level}）`
      : `${reason.label} ${reason.baseline}→${reason.measured}${reason.unit || ''}，偏差${reason.delta}${reason.unit || ''}（${reason.level}）`
  ).join('；');
  const linkedTodo = (state.db.todos || []).find((todo) => todo.surveyId === item.id);
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${pill(item.status || '-', toneFor(item.status))}</div>
    <div class="meta">${escapeHtml(site)}${item.grade && item.grade !== '正常' ? ` · 分级：<strong>${escapeHtml(item.grade)}</strong>` : ''}</div>
    ${item.disturbance ? `<p>干扰痕迹：${escapeHtml(item.disturbance)}</p>` : ''}
    <div class="detail">${details}</div>
    ${reasons ? `<div class="reasons">异常依据：${escapeHtml(reasons)}</div>` : ''}
    ${linkedTodo ? `<div class="meta">关联待办：${escapeHtml(linkedTodo.id)} · ${pill(linkedTodo.status, toneFor(linkedTodo.status))}</div>` : ''}
    ${historyHtml(item.history, 3)}
  </article>`;
}

function renderCrudList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[collection] || [])];
  if (query) items = items.filter((item) => view.searchFields.some((field) => String(item[field] || '').includes(query)));
  if (status) items = items.filter((item) => item[view.statusField] === status);
  if (!items.length) return `<div class="empty">暂无${escapeHtml(state.config.collections[collection]?.label || collection)}</div>`;
  return items.map((item) => collection === 'surveys' ? renderSurveyCard(item) : renderSiteCard(item, view)).join('');
}

/* ---------- 待办卡片 ---------- */

function deadlineInfo(todo) {
  if (!todo.open) return `<span class="meta">已于 ${fmtDate(todo.closedAt)} 销项</span>`;
  const left = new Date(todo.deadline).getTime() - Date.now();
  const overdue = left < 0;
  const text = overdue
    ? `已超时 ${Math.ceil(-left / 3600000)} 小时`
    : `剩余 ${Math.max(1, Math.floor(left / 3600000))} 小时`;
  return `<span class="deadline ${overdue ? 'overdue' : ''}">${text}</span>`;
}

function renderEvents(todo) {
  const events = [...(todo.events || [])].reverse();
  if (!events.length) return '';
  return `<div class="timeline">${events.map((event) => `
    <div class="timeline-item tone-${escapeHtml(event.type)}">
      <div class="timeline-dot"></div>
      <div>
        <div class="timeline-head"><strong>${escapeHtml(event.action)}</strong><span>${fmtDate(event.at)}</span></div>
        <div class="meta">${escapeHtml(event.actorName)}${event.detail ? '：' + escapeHtml(event.detail) : ''}</div>
      </div>
    </div>`).join('')}</div>`;
}

function renderTodoCard(todo) {
  const user = currentUser();
  const survey = state.db.surveys.find((entry) => entry.id === todo.surveyId);
  const site = state.db.sites.find((entry) => entry.id === todo.siteId);
  const stageMap = { pending: '待处理', handling: todo.status === '已驳回' ? '已驳回，待继续处理' : '处理中', review: '待复查', done: '已销项' };
  const buttons = [];
  if (todo.open && user) {
    if (user.role === 'surveyor') {
      if (todo.stage === 'pending' || (todo.stage === 'handling' && !todo.handlerId)) {
        buttons.push(`<button data-todo="claim" data-id="${todo.id}">领取处理</button>`);
      } else if (todo.stage === 'handling' && todo.handlerId === user.id) {
        buttons.push(`<button data-todo="submit" data-id="${todo.id}">提交复查</button>`);
      }
    }
    if (user.role === 'reviewer' && todo.stage === 'review' && todo.handlerId !== user.id) {
      buttons.push(`<button data-todo="close" data-id="${todo.id}">提交复查结论并销项</button>`);
      buttons.push(`<button class="danger" data-todo="reject" data-id="${todo.id}">驳回</button>`);
    }
  }
  const measures = [
    ['温度', survey?.temperature, site?.baselineTemp, '℃'],
    ['湿度', survey?.humidity, site?.baselineHumidity, '%'],
    ['CO2', survey?.co2, site?.baselineCo2, 'ppm'],
    ['滴水', survey?.dripRate, site?.baselineDrip, '滴/分']
  ].map(([label, value, base, unit]) =>
    `<div>${escapeHtml(label)}<br><strong>${value ?? '-'}${unit}</strong><span class="meta">基准 ${base ?? '-'}</span></div>`).join('');
  return `<article class="card todo-card ${todo.open ? '' : 'closed'}">
    <div class="card-head">
      <h3>${escapeHtml(todo.siteLabel || todo.siteId)} <span class="meta">${escapeHtml(todo.id)}</span></h3>
      <div class="pills">
        ${pill(todo.status, toneFor(todo.status))}
        ${pill(`${todo.grade}风险`, toneFor(todo.grade))}
        ${todo.escalated ? pill(`已升级×${todo.escalationLevel}`, 'bad') : ''}
      </div>
    </div>
    <div class="meta">上报人：${escapeHtml(todo.surveyor || '-')} ｜ 阶段：${escapeHtml(stageMap[todo.stage] || todo.stage)}
      ｜ 处理人：${escapeHtml(todo.handlerName || '待领取')} ｜ 复查人：${escapeHtml(todo.reviewerName || '待分配')}</div>
    <div class="detail">${measures}</div>
    ${todo.handlerNote ? `<p>现场处理：${escapeHtml(todo.handlerName)}：${escapeHtml(todo.handlerNote)}（${fmtDate(todo.handledAt)}）</p>` : ''}
    ${todo.reviewNote ? `<p>复查结论：${escapeHtml(todo.reviewerName)}：${escapeHtml(todo.reviewNote)}</p>` : ''}
    <div class="card-foot">${deadlineInfo(todo)}<div class="actions">${buttons.join('')}</div></div>
    <details class="track"><summary>查看轨迹（${(todo.events || []).length} 步）</summary>${renderEvents(todo)}</details>
  </article>`;
}

function filteredTodos() {
  let items = [...(state.db.todos || [])];
  if (state.todoFilter === 'open') items = items.filter((todo) => todo.open);
  if (state.todoFilter === 'mine') {
    const user = currentUser();
    items = items.filter((todo) => todo.open && (todo.handlerId === user?.id || todo.reviewerId === user?.id || (!todo.handlerId && user?.role === 'surveyor')));
  }
  if (state.todoFilter === 'closed') items = items.filter((todo) => !todo.open);
  return items;
}

function renderTodosView() {
  const items = filteredTodos();
  const user = currentUser();
  const counts = {
    open: (state.db.todos || []).filter((todo) => todo.open).length,
    mine: (state.db.todos || []).filter((todo) => todo.open && (todo.handlerId === user?.id || todo.reviewerId === user?.id || (!todo.handlerId && user?.role === 'surveyor'))).length,
    closed: (state.db.todos || []).filter((todo) => !todo.open).length
  };
  const tabs = [
    ['open', `待处理 ${counts.open}`],
    ['mine', `与我相关 ${counts.mine}`],
    ['closed', `已销项 ${counts.closed}`]
  ].map(([key, label]) =>
    `<button class="ghost filter-tab${state.todoFilter === key ? ' active' : ''}" data-todo-filter="${key}">${escapeHtml(label)}</button>`).join('');
  return `<section class="view" id="todos">
    <div class="panel">
      <h2>复查待办</h2>
      <p class="meta">异常巡测保存后自动生成一份待办：巡测员领取并现场处理 → 另一名复查员复核销项；处理人提交后复查员可驳回，驳回后退回处理人继续处理。每个环节都有处理时限，超时自动升级。</p>
      <div class="actions">${tabs}</div>
      <div class="list" style="margin-top:14px">${items.length ? items.map(renderTodoCard).join('') : '<div class="empty">暂无待办</div>'}</div>
    </div>
  </section>`;
}

/* ---------- 规则管理 ---------- */

function renderRulesView() {
  const settings = state.settings;
  if (!settings) return `<section class="view" id="rules"><div class="panel">规则加载中…</div></section>`;
  const rows = settings.metrics.map((metric) => `
    <tr>
      <td>${escapeHtml(metric.label)}（${escapeHtml(metric.unit)}）</td>
      <td><input type="number" min="0" step="0.1" data-rule="metric" data-key="${metric.key}" data-field="midDelta" value="${metric.midDelta}"></td>
      <td><input type="number" min="0" step="0.1" data-rule="metric" data-key="${metric.key}" data-field="highDelta" value="${metric.highDelta}"></td>
    </tr>`).join('');
  const sla = settings.slaHours;
  return `<section class="view" id="rules">
    <div class="panel rules-panel">
      <h2>判定规则（仅管理员可调整）</h2>
      <p class="meta">巡测保存后，系统按样点基准与四项实测值的偏差绝对值自动分级：偏差达到「中阈值」记中风险，达到「高阈值」记高风险，多项异常取最高等级；勾选干扰痕迹后，填写了干扰痕迹的巡测至少记中风险。规则调整即时生效（仅影响之后保存的巡测）。</p>
      <table class="rules-table">
        <thead><tr><th>指标</th><th>中风险偏差阈值</th><th>高风险偏差阈值</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="sla-grid">
        <label>中风险处理时限（小时）<input type="number" min="1" step="1" data-rule="sla" data-key="中" value="${sla['中']}"></label>
        <label>高风险处理时限（小时）<input type="number" min="1" step="1" data-rule="sla" data-key="高" value="${sla['高']}"></label>
        <label>复查环节时限（小时）<input type="number" min="1" step="1" data-rule="sla" data-key="review" value="${sla.review}"></label>
      </div>
      <label class="check"><input type="checkbox" id="disturbanceRule" ${settings.disturbanceAsSignal ? 'checked' : ''}> 干扰痕迹作为中风险信号</label>
      <label class="wide">调整原因（可选）<input type="text" id="ruleReason" placeholder="例如：雨季湿度阈值放宽"></label>
      <div class="actions"><button id="saveRules">保存规则</button></div>
      <div class="history">${(state.db.settings?.history || []).slice(0, 5).map((entry) =>
        `<div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.note)}${entry.actor ? ` · ${escapeHtml(entry.actor)}` : ''}</span></div>`).join('') || '<div class="meta">暂无调整记录</div>'}</div>
    </div>
  </section>`;
}

/* ---------- 看板与 CRUD 视图 ---------- */

function focusItems(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.custom === 'openTodos') {
    items = items.filter((item) => item.open)
      .sort((a, b) => new Date(a.deadline || 0) - new Date(b.deadline || 0));
  } else if (source.field) {
    items = items.filter((item) => source.values.includes(item[source.field]));
  }
  return items.slice(0, source.limit || 8);
}

function renderDashboardView(view) {
  const items = focusItems(view);
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="panel">
      <h2>${escapeHtml(view.focusTitle)}</h2>
      <div class="list">${items.length
        ? items.map((item) => item.surveyId ? renderTodoCard(item) : renderSurveyCard(item)).join('')
        : '<div class="empty">暂无重点事项</div>'}</div>
    </div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderCrudList(view)}</div>
      </div>
    </div>
  </section>`;
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views
    .filter((view) => visibleViews().some((visible) => visible.id === view.id))
    .map((view) => {
      if (view.type === 'dashboard') return renderDashboardView(view);
      if (view.type === 'todos') return renderTodosView();
      if (view.type === 'rules') return renderRulesView();
      return renderCrudView(view);
    }).join('');
  setTab(state.activeTab || visibleViews()[0]?.id);
}

async function load() {
  const [db, settingsRes] = await Promise.all([
    api('/api/db'),
    api('/api/settings').catch(() => ({ settings: null }))
  ]);
  state.db = db;
  state.settings = settingsRes.settings;
  render();
}

/* ---------- 备注弹窗 ---------- */

function openModal({ title, hint, placeholder, confirmLabel, danger }) {
  return new Promise((resolve) => {
    $('#modalTitle').textContent = title;
    $('#modalHint').textContent = hint || '';
    const text = $('#modalText');
    text.value = '';
    text.placeholder = placeholder || '';
    const confirm = $('#modalConfirm');
    confirm.textContent = confirmLabel || '确认';
    confirm.className = danger ? 'danger' : '';
    $('#modalMask').hidden = false;
    state.modal = { resolve };
    setTimeout(() => text.focus(), 0);
  });
}

function closeModal(value) {
  $('#modalMask').hidden = true;
  state.modal?.resolve(value);
  state.modal = null;
}

/* ---------- 事件 ---------- */

$('#userSelect').addEventListener('change', async (event) => {
  localStorage.setItem('caveUserId', event.target.value);
  renderTabs();
  await load();
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

$('#modalCancel').addEventListener('click', () => closeModal(null));
$('#modalMask').addEventListener('click', (event) => { if (event.target.id === 'modalMask') closeModal(null); });
$('#modalConfirm').addEventListener('click', () => {
  const value = $('#modalText').value.trim();
  closeModal(value);
});

document.addEventListener('click', async (event) => {
  if (event.target.closest('#saveRules')) {
    await saveRules();
    return;
  }
  const tab = event.target.closest('.tab');
  if (tab) { setTab(tab.dataset.tab); return; }

  const filterTab = event.target.closest('[data-todo-filter]');
  if (filterTab) {
    state.todoFilter = filterTab.dataset.todoFilter;
    render();
    return;
  }

  const siteAction = event.target.closest('[data-action]');
  if (siteAction) {
    try {
      await api(`/api/action/${siteAction.dataset.action}/${siteAction.dataset.id}`, { method: 'POST' });
      await load();
      toast('已更新');
    } catch (error) { toast(error.message); }
    return;
  }

  const todoBtn = event.target.closest('[data-todo]');
  if (todoBtn) {
    const { todo: kind, id } = todoBtn.dataset;
    try {
      if (kind === 'claim') {
        const result = await api(`/api/todos/${id}/claim`, { method: 'POST', body: JSON.stringify({ clientToken: token() }) });
        toast(result.duplicate ? '你已领取过该待办' : '领取成功');
      } else if (kind === 'submit') {
        const note = await openModal({
          title: '提交现场处理结果',
          hint: '提交后将进入复查环节，由另一名复查员复核。',
          placeholder: '请描述现场处置措施、观察到的情况…',
          confirmLabel: '提交复查'
        });
        if (note === null) return;
        if (!note) { toast('处理说明不能为空'); return; }
        const result = await api(`/api/todos/${id}/submit-handling`, {
          method: 'POST', body: JSON.stringify({ note, clientToken: token() })
        });
        toast(result.duplicate ? '已提交过，请勿重复操作' : '已提交复查');
      } else if (kind === 'reject') {
        const reason = await openModal({
          title: '驳回待办',
          hint: '驳回后退回处理人继续处理，时限重新计算。',
          placeholder: '请说明驳回原因…',
          confirmLabel: '确认驳回',
          danger: true
        });
        if (reason === null) return;
        if (!reason) { toast('驳回原因不能为空'); return; }
        const result = await api(`/api/todos/${id}/reject`, {
          method: 'POST', body: JSON.stringify({ reason, clientToken: token() })
        });
        toast(result.duplicate ? '已驳回过，请勿重复操作' : '已驳回');
      } else if (kind === 'close') {
        const note = await openModal({
          title: '复查销项',
          hint: '确认异常已解除后销项，巡测记录同步标记为已复查。',
          placeholder: '请填写复查结论…',
          confirmLabel: '确认销项'
        });
        if (note === null) return;
        if (!note) { toast('复查结论不能为空'); return; }
        const result = await api(`/api/todos/${id}/close`, {
          method: 'POST', body: JSON.stringify({ note, clientToken: token() })
        });
        toast(result.duplicate ? '已销项，请勿重复操作' : '复查销项完成');
      }
      await load();
    } catch (error) { toast(error.message); }
  }
});

async function saveRules() {
  const metrics = $$('[data-rule="metric"]').reduce((acc, input) => {
    const item = acc.find((entry) => entry.key === input.dataset.key) || { key: input.dataset.key };
    item[input.dataset.field] = Number(input.value);
    if (!acc.includes(item)) acc.push(item);
    return acc;
  }, []);
  const slaHours = {};
  $$('[data-rule="sla"]').forEach((input) => { slaHours[input.dataset.key] = Number(input.value); });
  try {
    await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({
        metrics,
        slaHours,
        disturbanceAsSignal: $('#disturbanceRule').checked,
        reason: $('#ruleReason').value.trim()
      })
    });
    toast('规则已保存');
    await load();
  } catch (error) { toast(error.message); }
}

document.addEventListener('input', (event) => {
  const view = state.config?.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (view) $(`#list-${view.id}`).innerHTML = renderCrudList(view);
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
  }
  const body = { ...view.defaults, ...payload, clientToken: token() };
  try {
    const result = await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(body) });
    form.reset();
    await load();
    if (form.dataset.create === 'surveys') {
      if (result.duplicate) toast('重复提交，已返回首次保存的记录');
      else if (result.todo) toast(`已保存：自动分级【${result.survey.grade}】，已生成复查待办`);
      else toast('已保存：指标正常，无需复查');
    } else {
      toast('已保存');
    }
  } catch (error) { toast(error.message); }
});

async function boot() {
  state.config = await api('/api/config');
  renderIdentity();
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
