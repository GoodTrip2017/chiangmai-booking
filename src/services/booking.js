/**
 * 建立／修改／取消預約。
 * 「讀狀態 → 判容量 → 寫入」在同一個交易內，並用 advisory lock 鎖住日期，
 * 避免兩位客人同時搶最後幾個位子而超賣。
 */
const crypto = require('node:crypto');
const { userError } = require('../util/errors');
const { pool } = require('../db');
const { CONFIG, SLOTS, LEGACY_SLOTS, REFERRAL_OPTIONS, SOURCES, STATUS } = require('../config');
const dt = require('../util/datetime');
const { capacityCheck } = require('./availability');
const { consumeLimit } = require('./rateLimits');
const { sendConfirmation } = require('./mailer');
const { notifyNewBooking, notifyUpdatedBooking, notifyCancelledBooking } = require('./lineNotify');

/** 表單欄位驗證，回傳整理過的資料或丟出錯誤 */
function validateForm(form, opts = {}) {
  if (!form || typeof form !== 'object' || Array.isArray(form)) throw userError('請求格式不正確。');
  const f = form;
  function textField(key) {
    const value = f[key] === undefined ? '' : f[key];
    if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
        (key !== 'note' && /[\r\n\t]/.test(value))) throw userError('欄位格式不正確。');
    return value.trim();
  }
  const name = textField('name');
  if (typeof f.pax !== 'number' && !(typeof f.pax === 'string' && /^\d+$/.test(f.pax))) throw userError('人數請填整數。');
  const pax = Number(f.pax);
  const dateStr = textField('date');
  const slot = textField('slot');
  const firstTime = textField('firstTime');
  const line = textField('line');
  const email = textField('email');
  const referral = textField('referral');

  if (!name) throw userError('請填寫預約人（綽號或本名）。');
  if (name.length > 60) throw userError('預約人名稱過長。');
  if (!Number.isSafeInteger(pax) || pax < 1) throw userError('人數請填 1 以上的整數。');
  if (pax > CONFIG.MAX_PAX) {
    throw Object.assign(userError(`線上預約每個時段最多接待 ${CONFIG.MAX_PAX} 人。多人團體歡迎先透過 LINE 私訊，由店員確認接待方式與可預約時段。`), {
      code: 'GROUP_CONTACT_REQUIRED', contactUrl: CONFIG.LINE_URL,
    });
  }
  if (!dt.isValidDateStr(dateStr)) throw userError('請選擇預約日期。');
  if (dt.isClosedDay(dateStr)) throw userError('每週二為固定公休日，請改選其他日期。');
  if (!SLOTS.some(def => def.slot === slot) && opts.allowedLegacySlot !== slot) throw userError('請選擇預約時段。');
  if (!opts.allowPast && dt.isSlotPast(dateStr, slot)) {
    throw userError('該時段已經開始或已過，請改選其他時段。');
  }
  if (!email) throw userError('請填寫 Email，確認信會寄到這個信箱。');
  if (!/^[^\s@<>(),;:\[\]\\"]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(email)) throw userError('Email 格式不正確。');
  if (email.length > 120) throw userError('Email 過長。');
  if (line.length > 80) throw userError('LINE 聯絡方式過長。');
  if (firstTime !== '是' && firstTime !== '否') throw userError('請選擇是否為第一次接觸。');
  if (!opts.referralOptional && !referral) throw userError('請選擇從哪邊知道我們的。');
  if (referral && !REFERRAL_OPTIONS.includes(referral)) throw userError('「從哪邊知道我們的」選項不正確。');

  const note = textField('note');
  if (note.length > 300) throw userError('備註過長（最多 300 字）。');

  return { name, pax, date: dateStr, slot, firstTime, line, email, referral, note };
}


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw userError('預約編號格式不正確。');
  return value;
}
async function lockSlots(client, entries) {
  // 舊時段可能與兩個新時段交疊，整日共用鎖才能避免跨時段超額。
  for (const date of [...new Set(entries.map(([date]) => date))].sort()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`booking-date:${date}`]);
  }
}
function rejectForce(payload) {
  if (payload?.force) throw userError('每個時段最多接待 12 人，無法強制超額安排。');
}
async function insertBooking(data, source, requestId) {
  const key = requestId ? validId(requestId) : crypto.randomUUID();
  const hash = crypto.createHash('sha256').update(JSON.stringify({ data, source })).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`request:${key}`]);
    const prior = await client.query('SELECT * FROM bookings WHERE request_key = $1', [key]);
    if (prior.rows.length) {
      const saved = prior.rows[0];
      // 舊請求不能讀到店員後續修正的個資，也不能把已取消預約顯示為成功。
      const unchanged = Object.entries(data).every(([field, value]) => saved[field === 'firstTime' ? 'first_time' : field] === value);
      if (saved.request_hash !== hash || saved.status !== STATUS.CONFIRMED || !unchanged) {
        throw userError('這次預約資料已變更，請透過 LINE 與店員確認目前的預約狀態。', 409);
      }
      await client.query('COMMIT');
      return { booking: prior.rows[0], replayed: true };
    }
    await lockSlots(client, [[data.date, data.slot]]);
    const check = await capacityCheck(client, data.date, data.slot, data.pax, null);
    if (!check.ok) throw userError(check.reason, 409);
    const { rows } = await client.query(
      `INSERT INTO bookings (source, name, pax, date, slot, first_time, line, email, referral, status, note, request_key, request_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [source, data.name, data.pax, data.date, data.slot, data.firstTime, data.line,
       data.email, data.referral, STATUS.CONFIRMED, data.note, key, hash]
    );
    await client.query('COMMIT');
    return { booking: rows[0], replayed: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}
async function trySendConfirmation(booking, requestKey) {
  let mailStatus;
  try { mailStatus = await sendConfirmation(booking, requestKey); }
  catch (err) {
    console.error('寄送確認信失敗：', err.code || err.name || 'UNKNOWN');
    mailStatus = 'FAILED';
  }
  // 預約已提交成功；通知狀態記錄失敗也不能讓客人以為預約失敗。
  try {
    await pool.query("UPDATE bookings SET mail_status = $1, note = replace(note, '[MAIL_FAILED]', '') WHERE id = $2", [mailStatus, booking.id]);
  } catch (err) { console.error('更新寄信狀態失敗：', err.code || 'UNKNOWN'); }
  booking.mail_status = mailStatus;
  return mailStatus;
}
function summaryResponse(booking, mailStatus) {
  return {
    ok: true, mailSent: mailStatus === 'ACCEPTED', mailStatus,
    summary: {
      name: booking.name, pax: booking.pax,
      dateLabel: dt.formatDateZh(booking.date), slotLabel: dt.slotLabelZh(booking.slot),
      email: booking.email, deadline: dt.graceDeadlineZh(booking.date, booking.slot),
      graceMinutes: CONFIG.GRACE_MINUTES,
    },
  };
}
async function submitBooking(form) {
  const data = validateForm(form);
  const { booking, replayed } = await insertBooking(data, 'WEB', form?.requestId);
  if (replayed) return summaryResponse(booking, booking.mail_status);
  void notifyNewBooking(booking);
  const mailStatus = await trySendConfirmation(booking, `confirmation/${booking.id}`);
  return summaryResponse(booking, mailStatus);
}
async function createManualBooking(payload) {
  const p = payload || {};
  rejectForce(p);
  const data = validateForm(p, { allowPast: true, referralOptional: true });
  const source = SOURCES.includes(p.source) ? p.source : 'WALK_IN';
  const { booking, replayed } = await insertBooking(data, source, p.requestId);
  if (!replayed) void notifyNewBooking(booking);
  let mailStatus = booking.mail_status;
  if (!replayed && p.sendMail && booking.email) mailStatus = await trySendConfirmation(booking, `confirmation/${booking.id}`);
  return { ok: true, mailSent: mailStatus === 'ACCEPTED', mailStatus, id: booking.id };
}
async function updateBooking(payload) {
  const p = payload || {};
  rejectForce(p);
  const id = validId(p.id);
  const client = await pool.connect();
  let updated, previous;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id]);
    const booking = rows[0];
    if (!booking) throw userError('找不到這筆預約。', 404);
    if (booking.status !== STATUS.CONFIRMED) throw userError('這筆預約已取消，無法修改。', 409);
    const allowedLegacySlot = p.date === booking.date && LEGACY_SLOTS.some(def => def.slot === booking.slot)
      ? booking.slot : undefined;
    const data = validateForm(p, { allowPast: true, referralOptional: true, allowedLegacySlot });
    await lockSlots(client, [[booking.date, booking.slot], [data.date, data.slot]]);
    const check = await capacityCheck(client, data.date, data.slot, data.pax, id);
    if (!check.ok) throw userError(check.reason, 409);
    const mailChanged = ['name', 'pax', 'date', 'slot', 'email'].some(field => booking[field] !== data[field]);
    const result = await client.query(
      `UPDATE bookings SET name=$1, pax=$2, date=$3, slot=$4, first_time=$5,
       line=$6, email=$7, referral=$8, note=$9, mail_status=$10 WHERE id=$11 RETURNING *`,
      [data.name, data.pax, data.date, data.slot, data.firstTime, data.line, data.email,
       data.referral, data.note, mailChanged ? 'NOT_REQUESTED' : booking.mail_status, id]
    );
    updated = result.rows[0];
    previous = booking;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
  void notifyUpdatedBooking(updated, previous);
  return { ok: true };
}
async function cancelBooking(id) {
  validId(id);
  const client = await pool.connect();
  let booking;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [id]);
    booking = rows[0];
    if (!booking) throw userError('找不到這筆預約。', 404);
    if (booking.status === STATUS.CANCELLED) { await client.query('COMMIT'); return { ok: true }; }
    await lockSlots(client, [[booking.date, booking.slot]]);
    await client.query('UPDATE bookings SET status=$1 WHERE id=$2', [STATUS.CANCELLED, id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
  void notifyCancelledBooking(booking);
  return { ok: true };
}
async function resendConfirmation(id) {
  validId(id);
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id=$1', [id]);
  const booking = rows[0];
  if (!booking) throw userError('找不到這筆預約。', 404);
  if (booking.status !== STATUS.CONFIRMED) throw userError('這筆預約已取消，無法寄出確認信。', 409);
  if (!booking.email) throw userError('這筆預約沒有留 Email。');
  await consumeLimit(`resend:${booking.id}`, 1, 60000, '這筆確認信剛剛已送出寄信請求，請稍候一分鐘再試。');
  await consumeLimit('resend-hour', 60, 3600000, '確認信寄送次數過多，請稍後再試。');
  const mailStatus = await trySendConfirmation(booking, `resend/${crypto.randomUUID()}`);
  if (mailStatus !== 'ACCEPTED') throw userError(mailStatus === 'NOT_CONFIGURED' ? '寄信服務尚未設定，預約仍保留。' : '確認信暫時無法寄出，預約仍保留。');
  return { ok: true, mailStatus };
}
module.exports = { validateForm, submitBooking, createManualBooking, updateBooking, cancelBooking, resendConfirmation };
