const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
if (!process.env.TEST_DATABASE_URL) throw new Error('請設定 TEST_DATABASE_URL，測試只會建立及清除獨立的測試 schema。');
const schema = 'test_booking_' + crypto.randomBytes(8).toString('hex');
const adminDb = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const databaseUrl = new URL(process.env.TEST_DATABASE_URL);
databaseUrl.searchParams.set('options', '-c search_path=' + schema + ',public');
process.env.DATABASE_URL = databaseUrl.toString();
process.env.DATABASE_SSL = 'false';
process.env.NODE_ENV = 'test';
for (const key of ['RESEND_API_KEY', 'MAIL_FROM', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'LINE_GROUP_ID']) delete process.env[key];
const { pool } = require('../src/db');
const { migrate } = require('../src/db/migrate');
const auth = require('../src/services/auth');
const booking = require('../src/services/booking');
const { createApp } = require('../src/app');
const password = crypto.randomBytes(24).toString('hex');
const form = { name: '測試預約', pax: 2, date: '2099-01-01', slot: '14:00-15:30', firstTime: '否', email: 'test@example.invalid', referral: '網路搜尋' };
let server, origin;
async function request(path, { method = 'GET', body, cookie, csrf, headers = {} } = {}) {
  const res = await fetch(origin + path, {
    method, redirect: 'manual', headers: {
      ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers,
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : method === 'GET' ? {} : { body: '{}' }),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, headers: res.headers, data };
}
async function login() {
  const res = await request('/api/admin/login', { method: 'POST', body: { password } });
  assert.equal(res.status, 200);
  return { cookie: res.headers.get('set-cookie').split(';')[0], csrf: res.data.csrfToken, headers: res.headers };
}
before(async () => {
  await adminDb.query(`CREATE SCHEMA "${schema}"`);
  // 模擬舊版資料表，確認 migration 可重複執行且保留舊資料。
  const initialSql = fs.readFileSync('src/db/schema.sql', 'utf8').split('-- 保留舊預約')[0];
  await pool.query(initialSql);
  await pool.query("INSERT INTO bookings(name,pax,date,slot) VALUES ('legacy',20,'2099-01-01','14:30-16:30')");
  await migrate(); await migrate();
  const legacy = (await pool.query("SELECT id, pax FROM bookings WHERE name='legacy'")).rows[0];
  assert.equal(legacy.pax, 20);
  await booking.cancelBooking(legacy.id);
  assert.equal((await pool.query('SELECT status, pax FROM bookings WHERE id=$1', [legacy.id])).rows[0].status, 'CANCELLED');
  process.env.ADMIN_PASSWORD_HASH = await auth.hashPassword(password);
  server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  process.env.APP_ORIGIN = origin;
});
beforeEach(async () => { await pool.query('TRUNCATE bookings, admin_sessions, admin_login_limits, request_limits'); });
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await pool.end();
  await adminDb.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await adminDb.end();
});
test('健康檢查與安全標頭；所有未登入後台入口都被保護', async () => {
  const health = await request('/healthz'); assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.match(health.headers.get('content-security-policy'), /script-src 'self';/);
  assert.equal((await request('/admin')).headers.get('location'), '/admin/login');
  assert.equal((await request('/admin.html')).headers.get('location'), '/admin');
  assert.equal((await request('/admin?token=old-token')).headers.get('location'), '/admin');
  assert.equal((await request('/api/admin/week?token=old-token', { headers: { 'X-Admin-Token': 'old-token' } })).status, 401);
});
test('密碼登入、Cookie、CSRF、跨站拒絕與登出撤銷', async () => {
  assert.equal((await request('/api/admin/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  assert.equal((await request('/api/admin/login', { method: 'POST', body: { password }, headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const session = await login();
  assert.match(session.headers.get('set-cookie'), /HttpOnly/);
  assert.match(session.headers.get('set-cookie'), /SameSite=Strict/);
  assert.equal((await request('/admin', session)).status, 200);
  assert.equal((await request('/api/admin/week', session)).status, 200);
  assert.equal((await request('/api/admin/bookings', { method: 'POST', cookie: session.cookie, body: form })).status, 403);
  assert.equal((await request('/api/admin/bookings', { ...session, method: 'POST', body: form, headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const created = await request('/api/admin/bookings', { ...session, method: 'POST', body: form });
  assert.equal(created.status, 200);
  assert.equal((await request('/api/admin/logout', { ...session, method: 'POST' })).status, 200);
  assert.equal((await request('/api/admin/week', session)).status, 401);
});
test('工作階段逾時及密碼輪替使舊登入立即失效', async () => {
  let session = await login();
  await pool.query("UPDATE admin_sessions SET expires_at=now()-interval '1 second'");
  assert.equal((await request('/api/admin/week', session)).status, 401);
  session = await login();
  const oldHash = process.env.ADMIN_PASSWORD_HASH;
  process.env.ADMIN_PASSWORD_HASH = await auth.hashPassword(password);
  assert.equal((await request('/api/admin/week', session)).status, 401);
  process.env.ADMIN_PASSWORD_HASH = oldHash;
});
test('登入嘗試限制持久儲存，第六次遭拒絕', async () => {
  for (let i=0; i<5; i++) assert.equal((await request('/api/admin/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  assert.equal((await request('/api/admin/login', { method: 'POST', body: { password } })).status, 429);
  assert.ok((await pool.query('SELECT * FROM admin_login_limits')).rows.length >= 2);
});
test('正式模式使用 Secure 及 __Host Cookie', async () => {
  process.env.NODE_ENV = 'production';
  try { const session = await login(); assert.match(session.headers.get('set-cookie'), /^__Host-admin_session=/); assert.match(session.headers.get('set-cookie'), /; Secure/); }
  finally { process.env.NODE_ENV = 'test'; }
});
test('前台 13 人遭拒，12 人可成立，未設定寄信不影響預約', async () => {
  const largeGroup = await request('/api/bookings', { method: 'POST', body: { ...form, pax: 13 } });
  assert.equal(largeGroup.status, 400);
  assert.equal(largeGroup.data.code, 'GROUP_CONTACT_REQUIRED');
  assert.equal(largeGroup.data.contactUrl, 'https://lin.ee/DcpM9f7');
  const res = await request('/api/bookings', { method: 'POST', body: { ...form, pax: 12, requestId: crypto.randomUUID() } });
  assert.equal(res.status, 200); assert.equal(res.data.mailStatus, 'NOT_CONFIGURED');
  const availability = await request('/api/availability?date=' + form.date);
  assert.equal(availability.data.slots[0].status, 'FULL');
  assert.equal((await pool.query('SELECT mail_status FROM bookings')).rows[0].mail_status, 'NOT_CONFIGURED');
});
test('切換 90 分鐘時段時保留舊預約，顯示後台並阻止重疊超額', async () => {
  const a = await pool.query("INSERT INTO bookings(name,pax,date,slot,email) VALUES ('舊預約甲',10,$1,'14:30-16:30',$2) RETURNING id", [form.date, form.email]);
  await pool.query("INSERT INTO bookings(name,pax,date,slot,email) VALUES ('舊預約乙',10,$1,'16:30-18:30',$2)", [form.date, form.email]);
  const availability = await request('/api/availability?date=' + form.date);
  assert.deepEqual(availability.data.slots.map(slot => slot.slot), [
    '14:00-15:30', '15:30-17:00', '17:00-18:30',
    '18:30-20:00', '20:00-21:30', '21:30-23:00',
  ]);
  assert.equal(availability.data.slots[1].maxPax, 2);
  await assert.rejects(booking.createManualBooking({ ...form, slot: '14:30-16:30' }), { status: 400 });
  await assert.rejects(booking.createManualBooking({ ...form, slot: '15:30-17:00', pax: 3 }), { status: 409 });
  const week = await request('/api/admin/week?monday=' + form.date, await login());
  assert.equal(week.status, 200);
  assert.ok(week.data.slotDefs.some(def => def.slot === '14:30-16:30' && def.legacy));
  assert.ok(week.data.days.some(day => day.slots.some(slot => slot.bookings.some(b => b.name === '舊預約甲'))));
  await booking.updateBooking({ ...form, id: a.rows[0].id, slot: '14:30-16:30', pax: 9 });
  await assert.rejects(booking.updateBooking({ ...form, id: a.rows[0].id, slot: '14:30-16:30', date: '2099-01-02' }), { status: 400 });
  await booking.createManualBooking({ ...form, slot: '15:30-17:00', pax: 2 });
  await assert.rejects(booking.createManualBooking({ ...form, slot: '15:30-17:00', pax: 1 }), { status: 409 });
});
test('後台新增、修改及 force 都不能超過 12 人', async () => {
  const first = await booking.createManualBooking({ ...form, pax: 10 });
  const second = await booking.createManualBooking({ ...form, pax: 2 });
  await assert.rejects(booking.createManualBooking({ ...form, pax: 1 }), { status: 409 });
  await assert.rejects(booking.createManualBooking({ ...form, pax: 1, force: true }), { status: 400 });
  await assert.rejects(booking.updateBooking({ ...form, id: second.id, pax: 3 }), { status: 409 });
  await assert.rejects(booking.updateBooking({ ...form, id: first.id, pax: 12, force: true }), { status: 400 });
  assert.equal((await pool.query('SELECT sum(pax)::int AS pax FROM bookings')).rows[0].pax, 12);
});
test('前台、後台新增及編輯缺少 Email 都遭拒絕', async () => {
  const session = await login();
  assert.equal((await request('/api/bookings', { method: 'POST', body: { ...form, email: '' } })).status, 400);
  assert.equal((await request('/api/admin/bookings', { ...session, method: 'POST', body: { ...form, email: '' } })).status, 400);
  const valid = await request('/api/admin/bookings', { ...session, method: 'POST', body: form });
  assert.equal(valid.status, 200);
  const missing = await request('/api/admin/bookings/' + valid.data.id, { ...session, method: 'PUT', body: { ...form, email: '' } });
  assert.equal(missing.status, 400);
  assert.equal((await pool.query('SELECT email FROM bookings WHERE id=$1', [valid.data.id])).rows[0].email, form.email);
});
test('20 筆同時新增只接受 12 位，真實 PostgreSQL 鎖定防超額', async () => {
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => booking.createManualBooking({ ...form, name: 'concurrent-' + i, pax: 1, requestId: crypto.randomUUID() })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 12);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.status === 409).length, 8);
  assert.equal((await pool.query('SELECT sum(pax)::int AS pax FROM bookings')).rows[0].pax, 12);
});
test('相同送出鍵同時重試只建立一筆；變更內容不能重用鍵', async () => {
  const data = { ...form, requestId: crypto.randomUUID() };
  const result = await Promise.all(Array.from({ length: 6 }, () => booking.createManualBooking(data)));
  assert.equal(new Set(result.map(r => r.id)).size, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n, 1);
  await assert.rejects(booking.createManualBooking({ ...data, name: 'different' }), { status: 409 });
});
test('兩筆同時移到剩餘兩位的時段，只容許一筆成功', async () => {
  await booking.createManualBooking({ ...form, pax: 10 });
  const one = await booking.createManualBooking({ ...form, slot: '15:30-17:00' });
  const two = await booking.createManualBooking({ ...form, slot: '17:00-18:30' });
  const results = await Promise.allSettled([one,two].map(b => booking.updateBooking({ ...form, id: b.id })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await pool.query('SELECT sum(pax)::int AS n FROM bookings WHERE slot=$1',[form.slot])).rows[0].n, 12);
});
test('修改跨時段釋出容量；取消保留資料並釋出座位', async () => {
  const b = await booking.createManualBooking({ ...form, pax: 12 });
  await booking.updateBooking({ ...form, id: b.id, slot: '15:30-17:00', pax: 12 });
  await booking.createManualBooking({ ...form, pax: 12 });
  await booking.cancelBooking(b.id);
  await booking.cancelBooking(b.id);
  assert.equal((await pool.query('SELECT status FROM bookings WHERE id=$1',[b.id])).rows[0].status, 'CANCELLED');
  await assert.rejects(booking.resendConfirmation(b.id), { status: 409 });
});
test('通知逾時保留成功預約並標記失敗，不再次新增', async () => {
  const previousFetch = global.fetch;
  process.env.RESEND_API_KEY='test'; process.env.MAIL_FROM='test@example.invalid';
  global.fetch = async () => { throw new DOMException('test', 'TimeoutError'); };
  try {
    const data = { ...form, requestId: crypto.randomUUID() };
    const result = await booking.submitBooking(data);
    assert.equal(result.ok, true); assert.equal(result.mailStatus, 'FAILED');
    assert.equal((await booking.submitBooking(data)).ok, true);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n, 1);
  } finally { global.fetch=previousFetch; delete process.env.RESEND_API_KEY; delete process.env.MAIL_FROM; }
});
test('錯誤不洩漏資料庫細節，資料庫不可用健康檢查回 503', async () => {
  assert.equal((await request('/api/availability?date=invalid')).status, 400);
  const query = pool.query;
  pool.query = async () => { throw Object.assign(new Error('sensitive database connection'), { code: 'ECONNREFUSED' }); };
  try { const health = await request('/healthz'); assert.equal(health.status,503); assert.deepEqual(health.data,{ok:false}); }
  finally { pool.query=query; }
});
