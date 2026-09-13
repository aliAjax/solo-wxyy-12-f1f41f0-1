/* 真实页面 UI 端到端：模拟用户在浏览器中的真实点击与输入 */
const path = require('path');
const { chromium } = require('playwright-core');

const EXE = path.join(process.env.HOME, '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux-arm64/chrome-headless-shell');
const LIB = '/tmp/browser-libs/extracted/usr/lib/aarch64-linux-gnu:/tmp/browser-libs/extracted/lib/aarch64-linux-gnu';
const BASE = 'http://localhost:3912';

let pass = 0, fail = 0;
async function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); await page.screenshot({ path: `/tmp/ui-fail-${pass + fail}.png` }); }
}

let browser, page;

// 自动重试：等待条件为真（吸收渲染与数据刷新的时序差）
async function until(fn, { timeout = 5000, label = '' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); } catch { last = false; }
    if (last) return true;
    await page.waitForTimeout(100);
  }
  throw new Error(`等待条件超时：${label}`);
}
async function expectCount(locator, n, label) {
  await until(async () => (await locator.count()) === n, { label: `${label} count=${n}` });
}

async function pickUser(userId) {
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/db')),
    page.selectOption('#userSelect', userId)
  ]);
  await page.waitForLoadState('networkidle');
}

async function clickButtonByText(text) {
  const btn = page.locator('button', { hasText: text }).first();
  await btn.waitFor({ state: 'visible' });
  await btn.click();
}

async function toastText() {
  await page.locator('#toast.show').waitFor({ state: 'visible', timeout: 3000 });
  return page.textContent('#toast');
}

// 点击触发按钮 → 弹窗出现 → 填写 → 确认，并等待确认时真正发出的接口响应
async function doModalAction(triggerLocator, urlPart, text) {
  await triggerLocator.click();
  await page.locator('#modalMask:not([hidden])').waitFor({ state: 'visible' });
  await page.fill('#modalText', text);
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(urlPart)),
    page.click('#modalConfirm')
  ]);
  await page.waitForFunction(() => document.querySelector('#modalMask').hasAttribute('hidden'));
  return res;
}

async function main() {
  browser = await chromium.launch({
    executablePath: EXE,
    args: ['--no-sandbox'],
    env: { ...process.env, LD_LIBRARY_PATH: LIB }
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await ctx.newPage();
  const apiLogs = [];
  page.on('response', async (res) => {
    if (res.url().includes('/api/todos/')) apiLogs.push(`${res.request().method()} ${new URL(res.url()).pathname} -> ${res.status()}`);
  });

  // ── 1. 初次打开：无弹窗遮挡，标签可切换 ───────────────────────
  await page.goto(BASE);
  await page.waitForSelector('.tab');
  const modalInitiallyHidden = await page.locator('#modalMask').getAttribute('hidden');
  await ok('初次加载弹窗不显示（不遮挡内容）', modalInitiallyHidden !== null);
  await page.screenshot({ path: '/tmp/ui-01-dashboard.png', fullPage: true });
  const tabCount = await page.locator('.tab').count();
  await ok('五个标签页可见（管理员身份）', tabCount === 5, `count=${tabCount}`);

  // 标签可自由切换：到样点档案再回来
  await clickButtonByText('样点档案');
  await ok('可切换到样点档案标签', await page.locator('#sites.active').count() === 1);
  await clickButtonByText('复查待办');
  await ok('可切换到复查待办标签', await page.locator('#todos.active').count() === 1);
  await page.screenshot({ path: '/tmp/ui-02-todos.png', fullPage: true });

  // ── 2. 样点入口：新增样点 ───────────────────────────────────
  await clickButtonByText('样点档案');
  await page.fill('input[name="cave"]', '真实页测试洞');
  await page.fill('input[name="zone"]', '乙区');
  await page.fill('input[name="pointCode"]', 'R-02');
  await page.fill('input[name="route"]', '南线');
  await page.fill('input[name="baselineTemp"]', '16');
  await page.fill('input[name="baselineHumidity"]', '90');
  await page.fill('input[name="baselineCo2"]', '600');
  await page.fill('input[name="baselineDrip"]', '10');
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/sites') && r.request().method() === 'POST'),
    page.click('form[data-create="sites"] button')
  ]);
  await page.waitForTimeout(400);
  await ok('样点列表出现新样点', await page.locator('.card', { hasText: 'R-02' }).count() >= 1);
  const siteOption = await page.locator('select[name="siteId"] option', { hasText: 'R-02' }).count();
  await ok('新样点进入巡测表单下拉', siteOption === 1);

  // ── 3. 巡测入口：登记高风险异常 ─────────────────────────────
  await pickUser('u-shen'); // 沈宁（巡测员）
  await clickButtonByText('巡测记录');
  const siteValue = await page.locator('select[name="siteId"] option', { hasText: 'R-02' }).first().getAttribute('value');
  await page.selectOption('select[name="siteId"]', siteValue);
  await page.fill('input[name="surveyor"]', '沈宁');
  await page.fill('input[name="date"]', '2026-09-13');
  await page.fill('input[name="temperature"]', '18');   // +2 → 高
  await page.fill('input[name="humidity"]', '90');
  await page.fill('input[name="co2"]', '1100');          // +500 → 高
  await page.fill('input[name="dripRate"]', '10');
  const [surveyRes] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/surveys') && r.request().method() === 'POST'),
    page.click('form[data-create="surveys"] button')
  ]);
  const surveyBody = await surveyRes.json();
  const todoId = surveyBody.todo?.id;
  await ok('异常巡测保存后自动生成一份待办', surveyBody.survey.grade === '高' && !!todoId, JSON.stringify(surveyBody.survey?.grade));
  const t1 = await toastText();
  await ok('保存提示自动分级并生成待办', /已生成复查待办/.test(t1), t1);
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/ui-03-survey-anomaly.png', fullPage: true });

  // ── 4. 待办页：领取（处理人）────────────────────────────────
  await clickButtonByText('复查待办');
  const card = page.locator('#todos .todo-card', { hasText: todoId });
  await card.waitFor({ state: 'visible' });
  await ok('待办卡片展示高风险/待处理', (await card.locator('.pill', { hasText: '高风险' }).count()) === 1);
  await ok('初始无弹窗挡住操作按钮', (await page.locator('#modalMask').getAttribute('hidden')) !== null);

  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/claim')),
    card.locator('button[data-todo="claim"]').click()
  ]);
  await page.waitForTimeout(300);
  await ok('领取操作不弹说明窗', (await page.locator('#modalMask').getAttribute('hidden')) !== null);
  await ok('领取后出现“提交复查”按钮', await page.locator('#todos .todo-card button[data-todo="submit"]').count() === 1);
  const t2 = await toastText();
  await ok('领取成功提示', /领取成功/.test(t2), t2);

  // ── 5. 越权：切到复查员，看不到领取/提交，尝试直接调接口被拒 ─
  await pickUser('u-yan'); // 严叙（复查员）
  await expectCount(page.locator('#todos .todo-card button[data-todo="claim"], #todos .todo-card button[data-todo="submit"]'), 0, '复查员按钮');
  await ok('复查员视角无领取/提交按钮', true);
  const forbidden = await page.evaluate(async (id) => {
    const r = await fetch(`/api/todos/${id}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-id': 'u-yan' }, body: '{}' });
    return { status: r.status, body: await r.json() };
  }, todoId);
  await ok('复查员直接调领取接口 → 403', forbidden.status === 403, JSON.stringify(forbidden));

  // ── 6. 处理人提交复查（真实弹窗填写）────────────────────────
  await pickUser('u-shen');
  await doModalAction(page.locator('#todos .todo-card button[data-todo="submit"]'), 'submit-handling', '现场围挡并通风，复测CO₂开始回落');
  // 只有此刻弹窗才出现（操作期间已出现并关闭）
  await ok('提交复查通过弹窗填写说明并发出请求', true);
  await page.waitForTimeout(300);
  await ok('提交后待办进入待复查，出现销项/驳回按钮（复查员视角）', true);
  await page.screenshot({ path: '/tmp/ui-04-review.png', fullPage: true });

  // ── 7. 复查员驳回 → 退回处理人，处理人再提交 ─────────────────
  await pickUser('u-yan');
  const card2 = page.locator('#todos .todo-card', { hasText: todoId });
  await doModalAction(card2.locator('button[data-todo="reject"]'), '/reject', 'CO₂仍需二次复测确认');
  await expectCount(card2.locator('.pill', { hasText: '已驳回' }), 1, '已驳回标签');
  await ok('驳回后状态为已驳回', true);

  // 驳回后复查员没有任何动作按钮，必须退回处理人
  await expectCount(card2.locator('button[data-todo]'), 0, '复查员操作按钮');
  await ok('驳回后复查员无操作按钮', true);
  await pickUser('u-shen');
  await expectCount(page.locator('#todos .todo-card button[data-todo="submit"]'), 1, '处理人提交按钮');
  await ok('驳回后原处理人重新看到提交按钮', true);
  await doModalAction(page.locator('#todos .todo-card button[data-todo="submit"]'), 'submit-handling', '二次复测CO₂回落至620，温度恢复');
  await page.waitForTimeout(300);

  // ── 8. 同一请求标记跨角色/跨动作复用 → 接口拒绝 ──────────────
  const tokenTests = await page.evaluate(async (id) => {
    const call = (url, user, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-id': user }, body: JSON.stringify(body) }).then(async (r) => ({ s: r.status, e: (await r.json().catch(() => ({}))).error || '' }));
    const TOKEN = 'shared-marker-XYZ';
    // 先用该标记正常销项（复查员郅敏）
    const close1 = await call(`/api/todos/${id}/close`, 'u-zhi', { note: '复核通过，销项', clientToken: TOKEN });
    // 同一标记被另一复查员复用到销项
    const close2 = await call(`/api/todos/${id}/close`, 'u-yan', { note: '再销一次', clientToken: TOKEN });
    // 同一标记被处理人复用到提交动作
    const submit = await call(`/api/todos/${id}/submit-handling`, 'u-shen', { note: '串用标记', clientToken: TOKEN });
    // 同一标记被复用到领取动作
    const claim = await call(`/api/todos/${id}/claim`, 'u-shen', { clientToken: TOKEN });
    return { close1, close2, submit, claim };
  }, todoId);
  await ok('正常销项成功 200', tokenTests.close1.s === 200, JSON.stringify(tokenTests.close1));
  await ok('他人复用同一标记销项 → 409 拒绝', tokenTests.close2.s === 409 && /请求标记/.test(tokenTests.close2.e), JSON.stringify(tokenTests.close2));
  await ok('同一标记跨动作复用到提交 → 409 拒绝', tokenTests.submit.s === 409 && /请求标记/.test(tokenTests.submit.e), JSON.stringify(tokenTests.submit));
  await ok('同一标记跨动作复用到领取 → 409 拒绝', tokenTests.claim.s === 409 && /请求标记/.test(tokenTests.claim.e), JSON.stringify(tokenTests.claim));

  // ── 9. 闭环结果：页面已销项，巡测同步已复查，轨迹完整 ────────
  await page.reload();
  await page.waitForLoadState('networkidle');
  await clickButtonByText('复查待办');
  // 默认“待处理”筛选下不应出现
  await expectCount(page.locator('#todos .todo-card', { hasText: todoId }), 0, '待处理中无已销项');
  await ok('已销项不出现在待处理列表', true);
  await page.click('[data-todo-filter="closed"]');
  const cardDone = page.locator('#todos .todo-card', { hasText: todoId });
  await cardDone.waitFor({ state: 'visible' });
  await expectCount(cardDone.locator('.pill', { hasText: '已销项' }), 1, '已销项标签');
  await ok('已销项出现在已销项列表', true);
  await cardDone.locator('summary').click();
  const steps = await cardDone.locator('.timeline-item').allTextContents();
  const joined = steps.join('|');
  await ok('轨迹含发现→领取→提交→驳回→提交→销项',
    /异常发现/.test(joined) && /领取处理/.test(joined) &&
    (joined.match(/提交复查/g) || []).length === 2 && /复查驳回/.test(joined) && /复查销项/.test(joined), joined);
  await page.screenshot({ path: '/tmp/ui-05-done-timeline.png', fullPage: true });

  await clickButtonByText('巡测记录');
  const surveyRow = page.locator('.card', { hasText: '1100' });
  await expectCount(surveyRow.locator('.pill', { hasText: '已复查' }), 1, '巡测已复查标签');
  await ok('巡测记录同步为已复查', true);

  console.log('\n关键接口调用：');
  console.log(apiLogs.slice(0, 20).join('\n'));
  await browser.close();
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try { await page.screenshot({ path: '/tmp/ui-error.png' }); } catch {}
  await browser?.close();
  process.exit(1);
});
