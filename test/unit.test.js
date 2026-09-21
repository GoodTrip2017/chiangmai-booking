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
const form = { name: '測試', pax: 2, date: '2099-01-01', slot: '14:30-16:30', firstTime: '否', email: 'test@example.invalid', referral: '網路搜尋' };

after(() => pool.end());
test('日期、清邁時區與保留時間', () => {
  assert.equal(dt.isClosedDay('2026-09-15'), true);
  assert.equal(dt.isValidDateStr('2026-02-30'), false);
  assert.equal(dt.isValidDateStr('2028-02-29'), true);
  assert.equal(dt.mondayOf('2026-09-20'), '2026-09-14');
  assert.equal(dt.graceDeadlineZh('2026-09-16', '14:30-16:30'), '下午 2:40');
});
test('前後台表單均拒絕 13 人、60 人、非整數與週二', () => {
  for (const opts of [{}, { allowPast: true, emailOptional: true, referralOptional: true }]) {
    assert.equal(validateForm({ ...form, pax: 12 }, opts).pax, 12);
    for (const pax of [0, -1, 1.5, 13, 60, Infinity]) assert.throws(() => validateForm({ ...form, pax }, opts), { status: 400 });
    assert.throws(() => validateForm({ ...form, date: '2026-09-15' }, opts));
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
  const check = (rows, pax) => capacityCheck({ query: async () => ({ rows }) }, form.date, form.slot, pax);
  assert.equal((await check([], 12)).ok, true);
  assert.equal((await check([], 13)).ok, false);
  assert.equal((await check([], 60)).ok, false);
  assert.equal((await check([{ pax: 10 }], 2)).ok, true);
  assert.equal((await check([{ pax: 10 }], 3)).ok, false);
  assert.equal((await check([{ pax: 13 }], 1)).ok, false);
});
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
  ctx.onDone({ mailStatus: 'NOT_CONFIGURED', summary: { name: '<img onerror=alert(1)>', email: 'x<y@example.invalid', pax: 2, dateLabel: 'date', slotLabel: 'slot', deadline: '下午 2:40', graceMinutes: 10 } });
  assert.equal(nodes.get('doneCard').children[1].children[1].text, '<img onerror=alert(1)>');
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
