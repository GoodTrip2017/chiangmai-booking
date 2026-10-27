/**
 * 客人端 Email 通知（取消）。寄信結果記錄在 notification_events（recipient_kind = CUSTOMER_EMAIL），
 * 與 LINE 群組推播共用同一張表，但不會被 LINE 的排程處理撿走。
 */
const { pool } = require('../db');
const mailer = require('./mailer');
const dt = require('../util/datetime');

async function recordEmailEvent(booking, eventType, status, failureReason, preview) {
  try {
    await pool.query(
      `INSERT INTO notification_events (booking_id,event_type,recipient_kind,recipient_id,idempotency_key,status,
         attempt_count,attempted_at,failure_reason,message_preview)
       VALUES ($1,$2,'CUSTOMER_EMAIL',$3,$4,$5,1,now(),$6,$7) ON CONFLICT (idempotency_key) DO NOTHING`,
      [booking.id, eventType, booking.email || '', `customer-email/${booking.id}/${booking.revision}/${eventType}`,
        status, failureReason, preview]
    );
  } catch (err) { console.error('記錄客人通知失敗：', err.code || 'UNKNOWN'); }
}

/** 取消後通知客人。到店時間已過的取消屬事後整理，不寄信。回傳 ACCEPTED / FAILED / NOT_CONFIGURED / NO_EMAIL / SKIPPED。 */
async function notifyCancellation(booking) {
  const subject = mailer.cancellationSubject(booking);
  if (dt.isSlotPast(booking.date, booking.slot)) {
    await recordEmailEvent(booking, 'BOOKING_CANCELLED', 'SKIPPED', 'VISIT_PASSED', subject);
    return 'SKIPPED';
  }
  let status;
  try { status = await mailer.sendCancellation(booking, `cancellation/${booking.id}/${booking.revision}`); }
  catch (err) {
    console.error('寄送取消通知失敗：', err.code || err.name || 'UNKNOWN');
    status = 'FAILED';
  }
  await recordEmailEvent(booking, 'BOOKING_CANCELLED', status, status === 'ACCEPTED' ? '' : status, subject);
  return status;
}

module.exports = { notifyCancellation };
