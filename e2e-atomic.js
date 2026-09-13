/* 写入失败原子性：data 目录只读时保存失败，db.json 必须保持原状且无残留 tmp */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = 'http://localhost:3912';
const DATA = path.join(__dirname, 'data');
const DB = path.join(DATA, 'db.json');
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
  const before = (await req('GET', '/api/db')).json;
  const countsBefore = { surveys: before.surveys.length, todos: before.todos.length };
  const fileBefore = fs.readFileSync(DB, 'utf8');
  const dbData = (await req('GET', '/api/db')).json;
  const siteId = dbData.sites[0].id;

  // 目录只读 → 新建 tmp 文件失败
  execSync(`chmod 555 ${DATA}`);
  try {
    const r = await req('POST', '/api/surveys', 'u-shen', {
      siteId, surveyor: '原子写测试', date: '2026-07-01',
      temperature: 30, humidity: 5, co2: 5000, dripRate: 99, clientToken: `atomic-${Date.now()}`
    });
    ok('写入失败时接口返回 5xx', r.status >= 500, `status=${r.status}`);

    const after = (await req('GET', '/api/db')).json;
    ok('失败后巡测数量不变（无半成品）', after.surveys.length === countsBefore.surveys);
    ok('失败后待办数量不变（无半成品）', after.todos.length === countsBefore.todos);

    const fileAfter = fs.readFileSync(DB, 'utf8');
    ok('db.json 字节级未被破坏', fileAfter === fileBefore);
    ok('db.json 仍是合法 JSON', (() => { try { JSON.parse(fileAfter); return true; } catch { return false; } })());

    const leftovers = fs.readdirSync(DATA).filter(n => n.endsWith('.tmp'));
    ok('无 .tmp 残留文件', leftovers.length === 0, leftovers.join(','));
  } finally {
    execSync(`chmod 755 ${DATA}`);
  }

  // 恢复后写入正常
  const r = await req('POST', '/api/surveys', 'u-shen', {
    siteId, surveyor: '原子写测试', date: '2026-07-02',
    temperature: 30, humidity: 5, co2: 5000, dripRate: 99, clientToken: `atomic-ok-${Date.now()}`
  });
  ok('恢复后保存成功并仍自动生成待办', r.status === 201 && r.json.todo && r.json.survey.grade === '高');

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { execSync(`chmod 755 ${DATA}`); console.error(e); process.exit(1); });
