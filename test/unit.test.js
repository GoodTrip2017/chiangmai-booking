const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const dt = require('../src/util/datetime');
const { validateForm } = require('../src/services/booking');
const { capacityCheck } = require('../src/services/availability');
const mailer = require('../src/services/mailer');
const { hashPassword } = require('../src/services/auth');
const { pool } = require('../src/db');
const { csvCell } = require('../src/services/reporting');
const notificationPolicy = require('../src/services/notificationPolicy');
const form = { name: '測試', pax: 2, date: '2099-01-01', slot: '14:00-15:30', firstTime: '否', email: 'test@example.invalid', referral: '網路搜尋' };

after(() => pool.end());
test('CSV 個資欄位不會成為試算表公式', () => {
  for (const value of ['=IMPORTXML("https://bad.invalid")', '+1+1', '-1+1', '@SUM(1)', '  =1+1', '\t=1+1']) {
    assert.ok(csvCell(value).startsWith('"\''), value);
  }
  assert.equal(csvCell('正常,名字'), '"正常,名字"');
  assert.equal(csvCell('a"b'), '"a""b"');
});
test('LINE 範本只接受受控變數，預覽替入預約資料', () => {
  assert.throws(() => notificationPolicy.validateTemplate('Hello {{password}}'), { status: 400 });
  assert.throws(() => notificationPolicy.validateTemplate('Hello {{name'), { status: 400 });
  const text = notificationPolicy.render('您好 {{name}}，{{date}} {{time}} 共 {{guests}} 人',
    { id: 'A', name: '陳先生', date: '2026-10-27', slot: '14:00-15:30', pax: 2 });
  assert.equal(text, '您好 陳先生，2026-10-27 14:00-15:30 共 2 人');
});
test('日期、清邁時區與保留時間', () => {
  assert.equal(dt.isClosedDay('2026-09-15'), true);
  assert.equal(dt.isValidDateStr('2026-02-30'), false);
  assert.equal(dt.isValidDateStr('2028-02-29'), true);
  assert.equal(dt.mondayOf('2026-09-20'), '2026-09-14');
  assert.equal(dt.graceDeadlineZh('2026-09-16', '14:00-15:30'), '下午 2:10');
  assert.deepEqual(require('../src/config').SLOTS.map(def => def.slot), [
    '14:00-15:30', '15:30-17:00', '17:00-18:30',
    '18:30-20:00', '20:00-21:30', '21:30-23:00',
  ]);
  assert.throws(() => validateForm({ ...form, slot: 'invalid-slot' }), { status: 400 });
});
test('前後台表單均拒絕 13 人、60 人與非整數；公休日由資料庫營業規則檢查', () => {
  for (const opts of [{}, { allowPast: true, emailOptional: true, referralOptional: true }]) {
    assert.equal(validateForm({ ...form, pax: 12 }, opts).pax, 12);
    for (const pax of [0, -1, 1.5, 13, 60, Infinity]) assert.throws(() => validateForm({ ...form, pax }, opts), { status: 400 });
    assert.equal(validateForm({ ...form, date: '2026-09-15' }, { ...opts, allowPast: true }).date, '2026-09-15');
  }
});
test('Email 統一必填，後台或舊 emailOptional 選項也不能繞過', () => {
  for (const opts of [{}, { allowPast: true, referralOptional: true }, { emailOptional: true }]) {
    for (const email of ['', '   ', 'invalid', 'a@b', 'a b@example.com']) {
      assert.throws(() => validateForm({ ...form, email }, opts), { status: 400 });
    }
    assert.equal(validateForm({ ...form, email: ' test@example.invalid ' }, opts).email, 'test@example.invalid');
  }
});
test('13 人以上提供 LINE 洽詢資訊，客人改回 12 人可恢復一般預約', () => {
  assert.throws(() => validateForm({ ...form, pax: 13 }), err => err.code === 'GROUP_CONTACT_REQUIRED' && err.contactUrl === 'https://lin.ee/DcpM9f7' && /店員確認/.test(err.message));
  const nodes = new Map();
  const doc = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, { children: [], addEventListener() {}, value: '' }); return nodes.get(id); } };
  const ctx = { document: doc, fetch: async () => ({ ok: true, json: async () => ({ today: '2026-09-14' }) }) };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('public/assets/booking.js', 'utf8'), ctx);
  nodes.get('pax').value = '13';
  assert.equal(ctx.updateGroupNotice(), true);
  assert.match(nodes.get('groupNotice').className, /show/);
  assert.equal(nodes.get('go').disabled, true);
  nodes.get('pax').value = '12';
  assert.equal(ctx.updateGroupNotice(), false);
  assert.doesNotMatch(nodes.get('groupNotice').className, /show/);
  assert.equal(nodes.get('go').disabled, false);
  assert.ok(fs.readFileSync('public/index.html', 'utf8').includes('透過 LINE 洽詢多人預約'));
});
test('第一組與多組共用同一個 12 人上限', async () => {
  const check = (rows, pax) => capacityCheck(mockAvailabilityDb(rows), form.date, form.slot, pax);
  assert.equal((await check([], 12)).ok, true);
  assert.equal((await check([], 13)).ok, false);
  assert.equal((await check([], 60)).ok, false);
  assert.equal((await check([{ pax: 10, slot: form.slot }], 2)).ok, true);
  assert.equal((await check([{ pax: 10, slot: form.slot }], 3)).ok, false);
  assert.equal((await check([{ pax: 13, slot: form.slot }], 1)).ok, false);
});
test('新時段扣除重疊舊預約，但不合計彼此不重疊的舊預約', async () => {
  const db = mockAvailabilityDb;
  const date = form.date;
  let check = await capacityCheck(db([{ slot: '14:30-16:30', pax: 10 }]), date, '14:00-15:30', 3);
  assert.equal(check.ok, false);
  check = await capacityCheck(db([{ slot: '14:30-16:30', pax: 10 }]), date, '15:30-17:00', 2);
  assert.equal(check.ok, true);
  check = await capacityCheck(db([{ slot: '14:30-16:30', pax: 10 }, { slot: '16:30-18:30', pax: 10 }]), date, '15:30-17:00', 2);
  assert.equal(check.ok, true);
  check = await capacityCheck(db([{ slot: '14:30-16:30', pax: 10 }, { slot: '16:30-18:30', pax: 10 }]), date, '15:30-17:00', 3);
  assert.equal(check.ok, false);
  check = await capacityCheck(db([{ slot: '14:30-16:30', pax: 12 }]), date, '17:00-18:30', 12);
  assert.equal(check.ok, true);
});
test('報到時增加的實際同行人數也占用後續重疊容量', async () => {
  const booking = { slot: form.slot, pax: 2, actual_pax: 4, capacity_pax: 4 };
  assert.equal((await capacityCheck(mockAvailabilityDb([booking]), form.date, form.slot, 8)).ok, true);
  assert.equal((await capacityCheck(mockAvailabilityDb([booking]), form.date, form.slot, 9)).ok, false);
});
test('縮小營運容量前會列出實際到店人數高於預約人數的受影響預約', async () => {
  const db = { query: async sql => ({ rows: sql.includes('FROM bookings')
    ? [{ id: 'affected', date: form.date, slot: form.slot, pax: 2, actual_pax: 4, status: 'CHECKED_IN' }]
    : [] }) };
  const settings = { open_time: '14:00', close_time: '23:00', service_minutes: 90, interval_minutes: 90,
    max_pax: 3, closed_weekdays: [2], max_advance_days: null, cutoff_minutes: 0, finish_before_close: true };
  const affected = await require('../src/services/rules').affectedBookings(db, settings);
  assert.equal(affected.length, 1);
  assert.equal(affected[0].reason, 'CAPACITY_REDUCED');
});
function mockAvailabilityDb(bookings) {
  return { query: async (sql) => {
    if (sql.includes('FROM availability_settings')) return { rows: [{ open_time:'14:00', close_time:'23:00', service_minutes:90,
      interval_minutes:90, max_pax:12, closed_weekdays:[2], max_advance_days:null, cutoff_minutes:0, finish_before_close:true }] };
    if (sql.includes('FROM availability_exceptions') || sql.includes('FROM slot_overrides')) return { rows: [] };
    return { rows: bookings };
  } };
}
test('確認信安全跳脫姓名，文案由店員處理逾時', () => {
  const booking = { ...form, name: '<img src=x onerror=alert(1)>' };
  const html = mailer.buildConfirmationHtml(booking);
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('自動取消'));
  assert.ok(!mailer.buildConfirmationText(booking).includes('自動取消'));
});
test('寄信未設定、成功、拒絕、連線逾時各自回報，使用 HTTPS 與去重鍵', async () => {
  const prior = { fetch: global.fetch, key: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM, replyTo: process.env.MAIL_REPLY_TO };
  try {
    delete process.env.RESEND_API_KEY; delete process.env.MAIL_FROM;
    assert.equal(await mailer.sendConfirmation(form), 'NOT_CONFIGURED');
    assert.equal(await mailer.sendConfirmation({ ...form, email: '' }), 'NO_EMAIL');
    process.env.RESEND_API_KEY = 'test-only'; process.env.MAIL_FROM = 'test@example.invalid';
    delete process.env.MAIL_REPLY_TO;
    global.fetch = async (url, options) => {
      assert.equal(url, 'https://api.resend.com/emails');
      assert.equal(options.headers['Idempotency-Key'], 'test-key');
      assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(JSON.parse(options.body).to, [form.email]);
      assert.equal(JSON.parse(options.body).reply_to, process.env.MAIL_REPLY_TO);
      return { ok: true, json: async () => ({ id: 'fake-email-id' }) };
    };
    assert.equal(await mailer.sendConfirmation(form, 'test-key'), 'ACCEPTED');
    process.env.MAIL_REPLY_TO = 'store@example.invalid';
    assert.equal(await mailer.sendConfirmation(form, 'test-key'), 'ACCEPTED');
    global.fetch = async () => ({ ok: false, status: 429 });
    await assert.rejects(mailer.sendConfirmation(form), { code: 'MAIL_HTTP_429' });
    global.fetch = async () => { throw new DOMException('simulated', 'TimeoutError'); };
    await assert.rejects(mailer.sendConfirmation(form), { name: 'TimeoutError' });
  } finally {
    global.fetch = prior.fetch;
    for (const [key, value] of [['RESEND_API_KEY', prior.key], ['MAIL_FROM', prior.from], ['MAIL_REPLY_TO', prior.replyTo]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
test('密碼使用獨立 salt 雜湊，不接受短密碼', async () => {
  const password = 'unit-test-password-123';
  const a = await hashPassword(password), b = await hashPassword(password);
  assert.notEqual(a, b);
  assert.ok(/^scrypt:16384:8:5:[a-f0-9]{32}:[a-f0-9]{128}$/.test(a));
  assert.ok(!a.includes(password));
  await assert.rejects(hashPassword('short'));
});
test('成功頁姓名與 Email 僅作文字；未送信不承諾 LINE 私訊', () => {
  function element() { return { children: [], style: {}, addEventListener() {}, replaceChildren(...c) { this.children=c; }, appendChild(c) { this.children.push(c); }, append(...c) { this.children.push(...c); }, set textContent(v) { this.text=String(v); }, get textContent() { return this.text; }, set innerHTML(v) { throw Error('成功頁不能解讀 HTML'); } }; }
  const nodes = new Map();
  const doc = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, createElement: element };
  const ctx = { document: doc, fetch: async () => ({ ok: true, json: async () => ({ today: '2026-09-14' }) }), window: { scrollTo() {} } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('public/assets/booking.js', 'utf8'), ctx);
  ctx.onDone({ mailStatus: 'NOT_CONFIGURED', summary: { bookingId: 'booking-123', name: '<img onerror=alert(1)>', email: 'x<y@example.invalid', pax: 2, dateLabel: 'date', slotLabel: 'slot', deadline: '下午 2:40', graceMinutes: 10 } });
  const details = nodes.get('doneCard').children[1].children;
  const nameIndex = details.findIndex((item) => item.text === '預約人');
  assert.equal(details[nameIndex + 1].text, '<img onerror=alert(1)>');
  assert.match(nodes.get('doneCard').children[2].text, /預約已成立/);
  assert.doesNotMatch(nodes.get('doneCard').children[2].text, /我們會另外透過 LINE/);
});
test('Railway 只信任邊緣 X-Real-IP，缺失或異常值共用受限桶', () => {
  const { clientIp } = require('../src/util/clientIp');
  const env = { NODE_ENV: 'production', RAILWAY_ENVIRONMENT_ID: 'test-environment' };
  for (const value of ['198.51.100.8', '2001:db8:abcd::1']) {
    assert.equal(clientIp({ ip: '203.0.113.9', headers: { 'x-real-ip': value } }, env), value);
  }
  for (const value of [undefined, '', 'unknown', '198.51.100.8, 203.0.113.9', ['198.51.100.8'], '198.51.100.8:1234']) {
    assert.equal(clientIp({ ip: '203.0.113.9', headers: { 'x-real-ip': value } }, env), 'unknown');
  }
  assert.equal(clientIp({ ip: '127.0.0.1', headers: { 'x-real-ip': '203.0.113.9' } }, { NODE_ENV: 'test' }), '127.0.0.1');
});
test('LINE 群組訊息使用雙語純文字，重試沿用固定 retry key', async () => {
  const lineNotify = require('../src/services/lineNotify');
  const sample = { id: '11111111-1111-4111-8111-111111111111', name: 'Test', pax: 2, date: '2099-01-01', slot: '14:00-15:30', source: 'WEB', note: '' };
  const message = lineNotify.buildBookingMessage(sample);
  assert.match(message, /Booking ID/);
  assert.match(message, /新預約已確認/);
  assert.doesNotMatch(message, /[🔔⭐✏️❌]/u);
  const oldFetch = global.fetch;
  const oldToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  let sent;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'unit-test';
  global.fetch = async (url, options) => { sent = { url, options }; return { ok: true, status: 200, headers: new Headers() }; };
  try {
    const result = await lineNotify.pushToGroup(message, 'group-test', sample.id);
    assert.equal(result.accepted, true);
    assert.equal(sent.options.headers['X-Line-Retry-Key'], sample.id);
    assert.equal(JSON.parse(sent.options.body).to, 'group-test');
  } finally {
    global.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    else process.env.LINE_CHANNEL_ACCESS_TOKEN = oldToken;
  }
});
test('確認信在設定 APP_ORIGIN 且預約有 token 時附自助取消連結，否則不附', () => {
  const booking = { id: '11111111-1111-4111-8111-111111111111', name: 'A', pax: 2, date: '2099-01-01', slot: '14:00-15:30', email: 'a@example.invalid', cancel_token: 'ab'.repeat(16) };
  const prior = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = 'https://booking.example.invalid';
  try {
    const expected = 'https://booking.example.invalid/cancel.html#booking=11111111-1111-4111-8111-111111111111&token=' + 'ab'.repeat(16);
    assert.ok(mailer.buildConfirmationText(booking).includes(expected));
    assert.ok(mailer.buildConfirmationHtml(booking).includes('href="' + expected.replace(/&/g, '&amp;') + '"'));
    assert.doesNotMatch(mailer.buildConfirmationText({ ...booking, cancel_token: null }), /cancel\.html/);
    delete process.env.APP_ORIGIN;
    assert.doesNotMatch(mailer.buildConfirmationText(booking), /cancel\.html/);
  } finally { if (prior === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = prior; }
});
test('前台重試送出沿用同一個 requestId，不會建立第二筆預約', async () => {
  const nodes = new Map();
  function element() {
    return { children: [], style: {}, handlers: {}, hidden: false, value: '', className: '', disabled: false,
      addEventListener(type, fn) { this.handlers[type] = fn; }, setAttribute() {}, scrollIntoView() {},
      replaceChildren(...c) { this.children = c; }, appendChild(c) { this.children.push(c); }, append(...c) { this.children.push(...c); },
      set textContent(v) { this.text = String(v); }, get textContent() { return this.text; } };
  }
  const doc = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, createElement: element };
  const bodies = []; let attempt = 0;
  const ctx = { document: doc, window: { scrollTo() {} }, crypto: { randomUUID: () => 'request-' + (++attempt) },
    fetch: async (path, options) => {
      if (path === '/api/bookings') {
        bodies.push(JSON.parse(options.body));
        if (bodies.length === 1) throw new Error('timeout');
        return { ok: true, json: async () => ({ ok: true, mailStatus: 'ACCEPTED', summary: { bookingId: 'b', name: 'A', email: 'a@example.invalid', pax: 1, dateLabel: 'd', slotLabel: 's', deadline: 't', graceMinutes: 10 } }) };
      }
      return { ok: true, json: async () => ({}) };
    } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('public/assets/booking.js', 'utf8'), ctx);
  const reviewed = { name: 'A', pax: 1, date: '2099-01-01', slot: '14:00-15:30', firstTime: '否', line: '', email: 'a@example.invalid',
    discoverySourceId: 'instagram', discoveryDetail: '', firstTouchSource: '', firstTouchMedium: '', firstTouchCampaign: '', trackingCode: '' };
  ctx.state.reviewedForm = reviewed;
  const click = nodes.get('reviewSubmit').handlers.click;
  click(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(bodies.length, 1);
  assert.equal(ctx.state.loading, false, 'failed submit must release the form');
  click(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].requestId, 'request-1');
  assert.equal(bodies[1].requestId, 'request-1', 'retry must reuse the same requestId');
  assert.equal(reviewed.requestId, undefined, 'reviewed form must not be mutated');
  ctx.state.reviewedForm = { ...reviewed, pax: 2 };
  ctx.state.loading = false;
  click(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(bodies[2].requestId, 'request-2', 'a changed form gets a new requestId');
});
