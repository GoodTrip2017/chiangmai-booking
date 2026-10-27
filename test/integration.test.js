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
const lifecycle = require('../src/services/lifecycle');
const reporting = require('../src/services/reporting');
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
beforeEach(async () => {
  await pool.query('TRUNCATE bookings, booking_events, notification_events, admin_sessions, staff_accounts, admin_login_limits, request_limits, availability_exceptions, slot_overrides, tracking_links, customers');
  await pool.query("UPDATE availability_settings SET open_time='14:00',close_time='23:00',service_minutes=90,interval_minutes=90,max_pax=12,closed_weekdays=ARRAY[2],max_advance_days=NULL,cutoff_minutes=0,finish_before_close=true WHERE id=1");
});
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
test('門市與分析帳號在伺服器端分權；停用帳號立即使工作階段失效', async () => {
  const administrator = await login();
  const staffPassword = 'staff-password-123456789';
  const analystPassword = 'analyst-password-123456789';
  const staff = await request('/api/admin/accounts', { ...administrator, method: 'POST', body: {
    username: 'frontdesk', displayName: 'Front Desk', role: 'STAFF', password: staffPassword,
  } });
  assert.equal(staff.status, 201);
  const analyst = await request('/api/admin/accounts', { ...administrator, method: 'POST', body: {
    username: 'reports', displayName: 'Reports', role: 'ANALYST', password: analystPassword,
  } });
  assert.equal(analyst.status, 201);
  const staffLogin = await request('/api/admin/login', { method: 'POST', body: { username: 'frontdesk', password: staffPassword } });
  assert.equal(staffLogin.status, 200);
  const staffSession = { cookie: staffLogin.headers.get('set-cookie').split(';')[0], csrf: staffLogin.data.csrfToken };
  assert.equal((await request('/api/admin/week', staffSession)).status, 200);
  assert.equal((await request('/api/admin/accounts', staffSession)).status, 403);
  assert.equal((await request('/api/admin/discovery-sources', { ...staffSession, method: 'POST', body: { labelZh: 'new', labelEn: 'new', sortOrder: 1 } })).status, 403);
  const item = await booking.createManualBooking(form);
  const analystLogin = await request('/api/admin/login', { method: 'POST', body: { username: 'reports', password: analystPassword } });
  assert.equal(analystLogin.status, 200);
  const analystSession = { cookie: analystLogin.headers.get('set-cookie').split(';')[0], csrf: analystLogin.data.csrfToken };
  assert.equal((await request('/api/admin/week', analystSession)).status, 403);
  assert.equal((await request('/api/admin/bookings/' + item.id, analystSession)).status, 403);
  assert.equal((await request('/api/admin/bookings', { ...analystSession, method: 'POST', body: form })).status, 403);
  const list = await request('/api/admin/bookings?from=' + form.date, analystSession);
  assert.equal(list.status, 200);
  assert.equal(list.data.items.length, 1);
  assert.equal(list.data.items[0].email, undefined);
  assert.equal(list.data.items[0].name, undefined);
  assert.equal((await request('/api/admin/analytics?from=' + form.date, analystSession)).status, 200);
  assert.equal((await request('/api/admin/bookings.csv?from=' + form.date, analystSession)).status, 403);
  assert.equal((await request('/api/admin/bookings.csv?from=' + form.date, staffSession)).status, 403);
  const exported = await request('/api/admin/bookings.csv?from=' + form.date, administrator);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /text\/csv/);
  assert.match(exported.data, /Asia\/Bangkok/);
  assert.match(exported.data, /測試預約/);
  assert.equal((await request('/api/admin/accounts/' + analyst.data.id, { ...administrator, method: 'PATCH', body: { active: false } })).status, 200);
  assert.equal((await request('/api/admin/analytics?from=' + form.date, analystSession)).status, 401);
});
test('負責人及內部備註有版本檢查、權限與操作者歷程', async () => {
  const administrator = await login();
  const staff = await request('/api/admin/accounts', { ...administrator, method: 'POST', body: {
    username: 'assignment', displayName: 'Assigned Staff', role: 'STAFF', password: 'staff-password-123456789',
  } });
  assert.equal(staff.status, 201);
  const created = await booking.createManualBooking(form);
  const path = '/api/admin/bookings/' + created.id + '/administration';
  const payload = { revision: 1, assignedStaffId: staff.data.id, internalNote: 'Call before arrival', reason: 'Assigned morning shift' };
  assert.equal((await request(path, { method: 'PATCH', body: payload })).status, 401);
  assert.equal((await request(path, { ...administrator, method: 'PATCH', body: { ...payload, reason: '' } })).status, 400);
  const result = await request(path, { ...administrator, method: 'PATCH', body: payload });
  assert.equal(result.status, 200);
  assert.equal((await request(path, { ...administrator, method: 'PATCH', body: payload })).status, 409);
  const detail = await request('/api/admin/bookings/' + created.id, administrator);
  assert.equal(detail.data.booking.assigned_staff_id, staff.data.id);
  assert.equal(detail.data.booking.internal_note, payload.internalNote);
  assert.equal(detail.data.history[0].event_type, 'ADMINISTRATION_UPDATED');
  assert.equal(detail.data.history[0].reason, payload.reason);
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
  await assert.rejects(booking.createManualBooking({ ...form, slot: '14:30-16:30' }), { status: 409 });
  await assert.rejects(booking.createManualBooking({ ...form, slot: '15:30-17:00', pax: 3 }), { status: 409 });
  const week = await request('/api/admin/week?monday=' + form.date, await login());
  assert.equal(week.status, 200);
  assert.ok(week.data.slotDefs.some(def => def.slot === '14:30-16:30' && def.legacy));
  assert.ok(week.data.days.some(day => day.slots.some(slot => slot.bookings.some(b => b.name === '舊預約甲'))));
  await booking.updateBooking({ ...form, id: a.rows[0].id, slot: '14:30-16:30', pax: 9 });
  await assert.rejects(booking.updateBooking({ ...form, id: a.rows[0].id, slot: '14:30-16:30', date: '2099-01-02' }), { status: 409 });
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
  const missing = await request('/api/admin/bookings/' + valid.data.id, { ...session, method: 'PUT', body: { ...form, email: '', revision: 1 } });
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
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1,
    results.map(r => r.status === 'rejected' ? r.reason.message : 'fulfilled').join('; '));
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
test('報到、部分到店、結案與版本衝突均保留歷程；統計不重複計數', async () => {
  const made = await booking.createManualBooking({ ...form, pax: 4 });
  const checked = await lifecycle.changeStatus(made.id, { status: 'CHECKED_IN', revision: 1, actualPax: 2 });
  assert.equal(checked.booking.actual_pax, 2);
  await assert.rejects(lifecycle.changeStatus(made.id, { status: 'COMPLETED', revision: 1 }), { status: 409 });
  const finished = await lifecycle.changeStatus(made.id, { status: 'COMPLETED', revision: 2 });
  assert.equal(finished.booking.status, 'COMPLETED');
  await assert.rejects(lifecycle.changeStatus(made.id, { status: 'NO_SHOW', revision: 3 }), { status: 409 });
  const report = await reporting.analytics({ from: form.date, to: form.date });
  assert.equal(report.summary.bookings, 1);
  assert.equal(report.summary.checked_in_bookings, 1);
  assert.equal(report.summary.actual_guests, 2);
  assert.equal(report.summary.completed_bookings, 1);
  const history = await reporting.bookingDetail(made.id);
  assert.deepEqual(history.history.map(item => item.event_type), ['STATUS_CHANGED','STATUS_CHANGED','CREATED']);
});
test('未到店必須經店員標記且只能在預約時間開始後', async () => {
  const future = await booking.createManualBooking(form);
  await assert.rejects(lifecycle.changeStatus(future.id, { status: 'NO_SHOW', revision: 1 }), { status: 409 });
  const old = await pool.query("INSERT INTO bookings(name,pax,date,slot,email) VALUES ('past',1,'2026-01-05','14:00-15:30',$1) RETURNING *", [form.email]);
  const marked = await lifecycle.changeStatus(old.rows[0].id, { status: 'NO_SHOW', revision: 1, reason: 'staff checked' });
  assert.equal(marked.booking.status, 'NO_SHOW');
});
test('營業設定可產生重疊時段；關店異動先列出受影響預約且不靜默取消', async () => {
  const rules = require('../src/services/rules');
  const first = await booking.createManualBooking({ ...form, pax: 10 });
  const settings = await rules.readSettings();
  const staggered = await rules.updateSettings({ ...settings, interval_minutes: 60 });
  assert.equal(staggered.ok, true);
  const availability = await request('/api/availability?date=' + form.date);
  assert.equal(availability.data.slots.find(item => item.slot === '15:00-16:30').maxPax, 2);
  await assert.rejects(booking.createManualBooking({ ...form, slot: '15:00-16:30', pax: 3 }), { status: 409 });
  const lowerCapacity = await rules.upsertSlotOverride({ date: form.date, slot: '15:00-16:30', max_pax: 8, blocked: false, reason: 'smaller room' });
  assert.equal(lowerCapacity.ok, false);
  assert.equal(lowerCapacity.affected[0].id, first.id);
  const preview = await rules.upsertException({ date: form.date, closed: true, reason: 'staff holiday' });
  assert.equal(preview.ok, false);
  assert.equal(preview.affected[0].id, first.id);
  assert.equal((await pool.query('SELECT status FROM bookings WHERE id=$1', [first.id])).rows[0].status, 'CONFIRMED');
  const applied = await rules.upsertException({ date: form.date, closed: true, reason: 'staff holiday', acknowledgeAffected: true });
  assert.equal(applied.ok, true);
  assert.equal((await request('/api/availability?date=' + form.date)).data.closed, true);
  await assert.rejects(booking.createManualBooking({ ...form, pax: 1 }), { status: 409 });
  assert.equal((await pool.query('SELECT status FROM bookings WHERE id=$1', [first.id])).rows[0].status, 'CONFIRMED');
  const tuesday = '2099-01-06';
  assert.equal((await request('/api/availability?date=' + tuesday)).data.closed, true);
  assert.equal((await rules.upsertException({ date: tuesday, closed: false, reason: 'special opening' })).ok, true);
  assert.equal((await request('/api/availability?date=' + tuesday)).data.closed, false);
  const special = await booking.createManualBooking({ ...form, date: tuesday, pax: 1 });
  assert.ok(special.id);
});
test('客人填寫來源、預約入口及首次 UTM 分開保存；合作代碼可產生 QR', async () => {
  const administrator = await login();
  const created = await request('/api/admin/tracking-links', { ...administrator, method: 'POST', body: {
    code: 'hotel-nimman', name: 'Nimman Hotel', kind: 'PARTNER',
    utmSource: 'hotel', utmMedium: 'qr', utmCampaign: 'front-desk',
  } });
  assert.equal(created.status, 201);
  const qr = await request('/api/admin/tracking-links/hotel-nimman/qr.svg', administrator);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(qr.data, /<svg/);
  const web = await request('/api/bookings', { method: 'POST', body: {
    ...form, referral: '', discoverySourceId: 'google-maps', trackingCode: 'hotel-nimman',
    firstTouchSource: 'hotel', firstTouchMedium: 'qr', firstTouchCampaign: 'front-desk',
  } });
  assert.equal(web.status, 200);
  const { rows } = await pool.query('SELECT discovery_source_id,entry_source,first_touch_source,first_touch_medium,partner_code FROM bookings');
  assert.deepEqual(rows[0], { discovery_source_id: 'google-maps', entry_source: 'WEB',
    first_touch_source: 'hotel', first_touch_medium: 'qr', partner_code: 'hotel-nimman' });
  const report = await request('/api/admin/analytics?from=' + form.date, administrator);
  assert.equal(report.data.discovery.find(row => row.id === 'google-maps').bookings, 1);
  assert.equal(report.data.tracked.find(row => row.code === 'hotel-nimman').bookings, 1);
});
test('Email 標準化建立穩定顧客 ID；不同姓名不影響回訪連結', async () => {
  const first = await booking.createManualBooking({ ...form, email: ' Test@Example.Invalid ', name: 'Name A' });
  const second = await booking.createManualBooking({ ...form, email: 'test@example.invalid', name: 'Name B', slot: '15:30-17:00' });
  const ids = (await pool.query('SELECT customer_id FROM bookings ORDER BY date,slot')).rows.map(row => row.customer_id);
  assert.equal(ids[0], ids[1]);
  assert.ok(ids[0]);
  const session = await login();
  const customers = await request('/api/admin/customers?search=test@example.invalid', session);
  assert.equal(customers.status, 200);
  assert.equal(customers.data.items[0].booking_count, 2);
  const detail = await request('/api/admin/customers/' + ids[0], session);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.bookings.length, 2);
  assert.notEqual(first.id, second.id);
});
test('錯誤不洩漏資料庫細節，資料庫不可用健康檢查回 503', async () => {
  assert.equal((await request('/api/availability?date=invalid')).status, 400);
  const query = pool.query;
  pool.query = async () => { throw Object.assign(new Error('sensitive database connection'), { code: 'ECONNREFUSED' }); };
  try { const health = await request('/healthz'); assert.equal(health.status,503); assert.deepEqual(health.data,{ok:false}); }
  finally { pool.query=query; }
});
