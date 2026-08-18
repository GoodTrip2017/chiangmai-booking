/**
 * 建立／修改／取消預約。
 * 「讀狀態 → 判容量 → 寫入」在同一個交易內，並用 advisory lock 鎖住 (date, slot)，
 * 避免兩位客人同時搶最後幾個位子而超賣。
 */
const { pool } = require('../db');
const { CONFIG, REFERRAL_OPTIONS, SOURCES, STATUS } = require('../config');
const dt = require('../util/datetime');
const { capacityCheck } = require('./availability');
const { sendConfirmation } = require('./mailer');
const { notifyNewBooking, notifyUpdatedBooking, notifyCancelledBooking } = require('./lineNotify');

/** 表單欄位驗證，回傳整理過的資料或丟出錯誤 */
function validateForm(form, opts = {}) {
  const f = form || {};
  const name = String(f.name || '').trim();
  const pax = Number(f.pax);
  const dateStr = String(f.date || '').trim();
  const slot = String(f.slot || '').trim();
  const firstTime = String(f.firstTime || '').trim();
  const line = String(f.line || '').trim();
  const email = String(f.email || '').trim();
  const referral = String(f.referral || '').trim();

  if (!name) throw new Error('請填寫預約人（綽號或本名）。');
  if (name.length > 60) throw new Error('預約人名稱過長。');
  if (!pax || pax < 1 || pax !== Math.floor(pax)) throw new Error('人數請填 1 以上的整數。');
  if (pax > CONFIG.MAX_PAX_INPUT) {
    throw new Error(`人數超過 ${CONFIG.MAX_PAX_INPUT} 人，請直接用 LINE 與我們聯絡安排。`);
  }
  if (!dt.isValidDateStr(dateStr)) throw new Error('請選擇預約日期。');
  if (dt.isClosedDay(dateStr)) throw new Error('每週二為固定公休日，請改選其他日期。');
  if (!dt.getSlotDef(slot)) throw new Error('請選擇預約時段。');
  if (!opts.allowPast && dt.isSlotPast(dateStr, slot)) {
    throw new Error('該時段已經開始或已過，請改選其他時段。');
  }
  if (!opts.emailOptional && !email) throw new Error('請填寫 Email，確認信會寄到這個信箱。');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Email 格式不正確。');
  if (email.length > 120) throw new Error('Email 過長。');
  if (line.length > 80) throw new Error('LINE 聯絡方式過長。');
  if (firstTime !== '是' && firstTime !== '否') throw new Error('請選擇是否為第一次接觸。');
  if (!opts.referralOptional && !referral) throw new Error('請選擇從哪邊知道我們的。');
  if (referral && !REFERRAL_OPTIONS.includes(referral)) throw new Error('「從哪邊知道我們的」選項不正確。');

  const note = String(f.note || '').trim();
  if (note.length > 300) throw new Error('備註過長（最多 300 字）。');

  return { name, pax, date: dateStr, slot, firstTime, line, email, referral, note };
}

/** 同一個 (date, slot) 的寫入互斥；交易結束自動解鎖 */
async function lockSlot(client, dateStr, slot) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${dateStr}|${slot}`]);
}

/** 在交易內寫入一筆預約。force = true 時跳過容量限制（僅後台使用），並在 note 留下記錄。 */
async function insertBooking(data, source, force) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockSlot(client, data.date, data.slot);

    const check = await capacityCheck(client, data.date, data.slot, data.pax, null);
    let note = data.note || '';
    if (!check.ok) {
      if (!force) {
        const err = new Error(check.reason);
        err.status = 409;
        throw err;
      }
      note = (note ? note + ' ' : '') + '[FORCE 超額新增]';
    }

    const { rows } = await client.query(
      `INSERT INTO bookings (source, name, pax, date, slot, first_time, line, email, referral, status, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [source, data.name, data.pax, data.date, data.slot, data.firstTime,
       data.line, data.email, data.referral, STATUS.CONFIRMED, note]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function appendNote(booking, text) {
  const note = (booking.note ? booking.note + ' ' : '') + text;
  booking.note = note;
  await pool.query('UPDATE bookings SET note = $1 WHERE id = $2', [note, booking.id]);
}

/** 寄確認信；失敗不讓預約本身失敗，只在 note 留記錄。回傳是否寄成功。 */
async function trySendConfirmation(booking) {
  try {
    return await sendConfirmation(booking);
  } catch (err) {
    console.error('寄送確認信失敗：', err);
    await appendNote(booking, '[MAIL_FAILED]');
    return false;
  }
}

/** 前台送出預約 */
async function submitBooking(form) {
  const data = validateForm(form);
  const booking = await insertBooking(data, 'WEB', false);
  notifyNewBooking(booking);          // 群組推播，失敗不影響預約
  const mailSent = await trySendConfirmation(booking);

  return {
    ok: true,
    mailSent,
    summary: {
      name: booking.name,
      pax: booking.pax,
      dateLabel: dt.formatDateZh(booking.date),
      slotLabel: dt.slotLabelZh(booking.slot),
      email: booking.email,
      deadline: dt.graceDeadlineZh(booking.date, booking.slot),
    },
  };
}

/** 後台手動新增預約（電話／LINE／現場上門） */
async function createManualBooking(payload) {
  const p = payload || {};
  const data = validateForm(p, { allowPast: true, emailOptional: true, referralOptional: true });
  const source = SOURCES.includes(p.source) ? p.source : 'WALK_IN';
  const booking = await insertBooking(data, source, !!p.force);
  notifyNewBooking(booking);          // 群組推播，失敗不影響預約

  let mailSent = false;
  if (p.sendMail && booking.email) {
    mailSent = await trySendConfirmation(booking);
  }
  return { ok: true, mailSent, id: booking.id };
}

/** 修改既有預約。容量驗證會排除這筆自己，force = true 可強制存檔。 */
async function updateBooking(payload) {
  const p = payload || {};
  const id = String(p.id || '');
  if (!id) throw new Error('缺少預約編號。');
  const data = validateForm(p, { allowPast: true, emailOptional: true, referralOptional: true });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockSlot(client, data.date, data.slot);

    const { rows } = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id]);
    const booking = rows[0];
    if (!booking) throw new Error('找不到這筆預約（可能已被其他人修改或刪除，請重新整理）。');
    if (booking.status !== STATUS.CONFIRMED) throw new Error('這筆預約已取消，無法修改。');

    const check = await capacityCheck(client, data.date, data.slot, data.pax, id);
    let note = data.note;
    if (!check.ok) {
      if (!p.force) {
        await client.query('ROLLBACK');
        return { ok: false, needsForce: true, reason: check.reason };
      }
      note = (note ? note + ' ' : '') + '[FORCE 超額調整]';
    }

    await client.query(
      `UPDATE bookings SET name = $1, pax = $2, date = $3, slot = $4,
         first_time = $5, line = $6, email = $7, referral = $8, note = $9
       WHERE id = $10`,
      [data.name, data.pax, data.date, data.slot, data.firstTime,
       data.line, data.email, data.referral, note, id]
    );
    await client.query('COMMIT');
    notifyUpdatedBooking(
      { ...booking, name: data.name, pax: data.pax, date: data.date, slot: data.slot,
        line: data.line, email: data.email, note },
      { date: booking.date, slot: booking.slot }
    );
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** 取消預約（軟刪除，保留紀錄；不寄取消信） */
async function cancelBooking(id) {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [String(id || '')]);
  const booking = rows[0];
  if (!booking) throw new Error('找不到這筆預約（可能已被其他人修改或刪除，請重新整理）。');
  if (booking.status === STATUS.CANCELLED) return { ok: true };

  await pool.query('UPDATE bookings SET status = $1 WHERE id = $2', [STATUS.CANCELLED, booking.id]);
  notifyCancelledBooking(booking);
  return { ok: true };
}

/** 重寄確認信 */
async function resendConfirmation(id) {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [String(id || '')]);
  const booking = rows[0];
  if (!booking) throw new Error('找不到這筆預約。');
  if (!booking.email) throw new Error('這筆預約沒有留 Email。');
  const sent = await sendConfirmation(booking);
  if (!sent) throw new Error('SMTP 尚未設定，無法寄信。');
  return { ok: true };
}

module.exports = {
  validateForm, submitBooking, createManualBooking, updateBooking,
  cancelBooking, resendConfirmation,
};
