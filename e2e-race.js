/* 并发竞态 + 原子写失败验证 */
const BASE = 'http://localhost:3912';
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}
async function req(method, p, user, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (user) headers['x-user-id'] = user;
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main() {
  // 准备一个新的高风险待办
  const db = (await req('GET', '/api/db')).json;
  const siteId = db.sites[0].id;
  const r = await req('POST', '/api/surveys', 'u-shen', {
    siteId, surveyor: '并发测试员', date: `2026-08-${10 + Math.floor(Math.random() * 10)}`,
    temperature: 20, humidity: 99, co2: 2000, dripRate: 30, clientToken: `race-${Date.now()}`
  });
  const todoId = r.json.todo.id;

  // 两名巡测员同时领取同一待办
  const [a, b] = await Promise.all([
    req('POST', `/api/todos/${todoId}/claim`, 'u-shen', { clientToken: 'ra-1' }),
    req('POST', `/api/todos/${todoId}/claim`, 'u-luo', { clientToken: 'rb-1' })
  ]);
  const codes = [a.status, b.status].sort().join(',');
  ok('并发领取恰有一人成功（200 + 409）', codes === '200,409', codes);
  const after = (await req('GET', '/api/db')).json;
  const todo = after.todos.find(t => t.id === todoId);
  ok('待办只记录一名处理人', ['u-shen', 'u-luo'].includes(todo.handlerId) && todo.events.filter(e => e.type === 'claimed').length === 1);

  // 并发重复提交同一处理结果（不同 token 模拟双击 + 同 token 重放）
  const winner = a.status === 200 ? 'u-shen' : 'u-luo';
  const loser = winner === 'u-shen' ? 'u-luo' : 'u-shen';
  const [s1, s2, s3] = await Promise.all([
    req('POST', `/api/todos/${todoId}/submit-handling`, winner, { note: '处理A', clientToken: 'ss-1' }),
    req('POST', `/api/todos/${todoId}/submit-handling`, winner, { note: '处理A', clientToken: 'ss-1' }),
    req('POST', `/api/todos/${todoId}/submit-handling`, loser, { note: '处理B', clientToken: 'ss-2' })
  ]);
  ok('并发提交：本人两次一次生效一次幂等重放、他人被拒',
    s1.status === 200 && s2.status === 200 &&
    [s1.json.duplicate, s2.json.duplicate].filter(Boolean).length === 1 &&
    s3.status === 403,
    `${s1.status},${s2.status},${s3.status}`);
  const finalTodo = (await req('GET', '/api/db')).json.todos.find(t => t.id === todoId);
  ok('并发后只进入一次复查阶段（submitted 事件恰好一次）',
    finalTodo.events.filter(e => e.type === 'submitted').length === 1);

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
