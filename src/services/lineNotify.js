/**
 * 新預約自動推播到工作群組（LINE Messaging API push message）。
 * LINE_CHANNEL_ACCESS_TOKEN 或 LINE_GROUP_ID 未設定時直接跳過，不影響預約流程。
 */
const dt = require('../util/datetime');
const { pool } = require('../db');
const policy = require('./notificationPolicy');
const { userError } = require('../util/errors');
const { consumeLimit } = require('./rateLimits');

function isConfigured() {
  return !!(process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_GROUP_ID);
}

const SOURCE_LABEL = { WEB: '網路預約', WALK_IN: '現場上門', LINE: 'LINE', PHONE: '電話' };

function bookingDetailLines(booking) {
  const lines = [
    `預約編號 / Booking ID: ${booking.id}`,
    `預約人 / Contact: ${booking.name}`,
    `人數 / Guests: ${booking.pax}`,
    `到店時間 / Visit time: ${dt.formatDateZh(booking.date)} ${booking.slot} (GMT+7)`,
  ];
  const contact = [booking.line && `LINE: ${booking.line}`, booking.email]
    .filter(Boolean).join(' · ');
  if (contact) lines.push(contact);
  return lines;
}

function buildBookingMessage(booking) {
  const lines = ['新預約已確認 / New booking confirmed', ...bookingDetailLines(booking)];
  if (booking.first_time === '是') lines.push('首次體驗 / First-time experience');
  lines.push(`預約入口 / Entry source: ${SOURCE_LABEL[booking.source] || booking.source}`);
  if (booking.note) lines.push(`客人備註 / Customer note: ${booking.note}`);
  return lines.join('\n');
}

/** prev = 修改前的資料，時段有變動時顯示「原時段」方便店員對照 */
function buildUpdateMessage(booking, prev) {
  const lines = ['預約已修改 / Booking updated', ...bookingDetailLines(booking)];
  if (prev && (prev.date !== booking.date || prev.slot !== booking.slot)) {
    lines.push(`原時段 / Previous time: ${dt.formatDateZh(prev.date)} ${prev.slot}`);
  }
  if (booking.note) lines.push(`客人備註 / Customer note: ${booking.note}`);
  return lines.join('\n');
}

function buildCancelMessage(booking) {
  return ['預約已取消 / Booking cancelled', ...bookingDetailLines(booking)].join('\n');
}

/** LINE 只承諾 API 接受；群組實際送達與已讀無法由此回應確認。 */
async function pushToGroup(text, recipient = process.env.LINE_GROUP_ID, retryKey) {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN || !recipient) return { accepted: false, statusCode: 0, retryable: false, error: 'NOT_CONFIGURED' };
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        ...(retryKey ? { 'X-Line-Retry-Key': retryKey } : {}),
      },
      body: JSON.stringify({
        to: recipient,
        messages: [{ type: 'text', text }],
      }),
    });
    return { accepted: res.ok || (res.status === 409 && !!res.headers.get('x-line-accepted-request-id')),
      statusCode: res.status, retryable: res.status >= 500 || res.status === 429,
      error: res.ok ? '' : `HTTP_${res.status}` };
  } catch (err) {
    console.error('LINE 推播失敗：', err.name);
    return { accepted: false, statusCode: 0, retryable: true, error: err.name || 'NETWORK_ERROR' };
  }
}

async function enqueueGroup(client, booking, eventType, previous = null) {
  const setting = await policy.getPolicy(client, eventType);
  if (!setting.enabled) return;
  const recipient = process.env.LINE_GROUP_ID || '';
  const configured = isConfigured();
  const rendered = policy.preview(setting, booking, typeof previous === 'object' ? previous : null);
  const tooLong = rendered.length > 5000;
  await client.query(
    `INSERT INTO notification_events (booking_id,event_type,recipient_kind,recipient_id,idempotency_key,status,
      failure_reason,message_preview) VALUES ($1,$2,'LINE_GROUP',$3,$4,$5,$6,$7) ON CONFLICT (idempotency_key) DO NOTHING`,
    [booking.id, eventType, recipient, `line-group/${booking.id}/${booking.revision}/${eventType}`,
      configured && !tooLong ? 'QUEUED' : 'FAILED', tooLong ? 'MESSAGE_TOO_LONG' : configured ? '' : 'NOT_CONFIGURED', rendered]
  );
}

async function cancelReminder(client, bookingId) {
  await client.query("UPDATE notification_events SET status='SKIPPED',failure_reason='BOOKING_CHANGED' WHERE booking_id=$1 AND event_type='REMINDER' AND status IN ('QUEUED','RETRY')", [bookingId]);
}

async function scheduleReminder(client, booking) {
  const setting = await policy.getPolicy(client, 'REMINDER');
  if (!setting.enabled || !isConfigured()) return;
  const sendAt = new Date(dt.toUtcMs(booking.date, booking.slot.slice(0, 5)) - setting.reminder_minutes * 60000);
  if (sendAt.getTime() <= Date.now()) return;
  const text = policy.preview(setting, booking);
  if (text.length > 5000) return;
  await client.query(
    `INSERT INTO notification_events (booking_id,event_type,recipient_kind,recipient_id,idempotency_key,status,
      failure_reason,message_preview,scheduled_at) VALUES ($1,'REMINDER','LINE_GROUP',$2,$3,'QUEUED','',$4,$5)
      ON CONFLICT (idempotency_key) DO NOTHING`,
    [booking.id, process.env.LINE_GROUP_ID, `line-group/${booking.id}/${booking.revision}/REMINDER`, text, sendAt]
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function previewManual(bookingId, eventType) {
  if (typeof bookingId !== 'string' || !UUID.test(bookingId)) throw userError('預約編號格式不正確 / Invalid booking ID.');
  if (!policy.EVENTS.includes(eventType)) throw userError('通知事件不正確 / Invalid notification event.');
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id=$1', [bookingId]);
  const booking = rows[0];
  if (!booking) throw userError('找不到這筆預約 / Booking not found.', 404);
  const setting = await policy.getPolicy(pool, eventType);
  const previous = booking.original_date ? { date: booking.original_date, slot: booking.original_slot || booking.slot } : null;
  const eligible = eventType === 'BOOKING_CANCELLED' ? booking.status === 'CANCELLED'
    : eventType === 'BOOKING_CONFIRMED' ? booking.status === 'CONFIRMED'
      : ['PENDING','CONFIRMED'].includes(booking.status) &&
        (eventType !== 'REMINDER' || dt.toUtcMs(booking.date, booking.slot.slice(0, 5)) > Date.now());
  return { eventType, enabled: setting.enabled, eligible, recipientKind: 'LINE_GROUP',
    recipientId: process.env.LINE_GROUP_ID || '', configured: isConfigured(),
    message: policy.preview(setting, booking, previous) };
}

async function resendManual(bookingId, eventType, requestId) {
  if (typeof bookingId !== 'string' || !UUID.test(bookingId)) throw userError('預約編號格式不正確 / Invalid booking ID.');
  if (typeof requestId !== 'string' || !UUID.test(requestId)) {
    throw userError('請求編號不正確 / Invalid request ID.');
  }
  const key = `line-group-manual/${bookingId}/${eventType}/${requestId}`;
  const existing = await pool.query('SELECT id,status FROM notification_events WHERE idempotency_key=$1', [key]);
  if (existing.rows[0]) return { ok: true, eventId: existing.rows[0].id, status: existing.rows[0].status, replayed: true };
  const preview = await previewManual(bookingId, eventType);
  if (!preview.enabled) throw userError('這類通知目前已停用 / This notification type is disabled.', 409);
  if (!preview.eligible) throw userError('目前預約狀態不適合這類通知 / This event does not match the booking state.', 409);
  if (!preview.configured) throw userError('LINE 工作群組尚未設定 / Staff group is not configured.', 409);
  if (preview.message.length > 5000) throw userError('訊息超過 LINE 長度限制 / Message is too long.', 409);
  await consumeLimit(`line-manual:${bookingId}:${eventType}`, 1, 60000, '這筆通知剛剛已重送，請稍候一分鐘 / Wait one minute before resending.');
  await consumeLimit('line-manual-hour', 30, 3600000, 'LINE 手動通知太頻繁，請稍後再試 / Too many manual notifications.');
  const { rows } = await pool.query(
    `INSERT INTO notification_events (booking_id,event_type,recipient_kind,recipient_id,idempotency_key,status,message_preview)
     VALUES ($1,$2,'LINE_GROUP',$3,$4,'QUEUED',$5)
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id,status`,
    [bookingId, eventType, preview.recipientId, key, preview.message]
  );
  void processPending().catch(err => console.error('LINE 通知處理失敗：', err.code || err.name));
  return { ok: true, eventId: rows[0].id, status: rows[0].status, replayed: false };
}

async function claimNext() {
  const { rows } = await pool.query(
    `WITH next AS (
       SELECT id FROM notification_events WHERE recipient_kind='LINE_GROUP'
       AND ((status IN ('QUEUED','RETRY') AND scheduled_at<=now())
         OR (status='SENDING' AND attempted_at<now()-interval '2 minutes'))
       ORDER BY scheduled_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
     ) UPDATE notification_events e SET status='SENDING',attempt_count=e.attempt_count+1,attempted_at=now()
     FROM next WHERE e.id=next.id RETURNING e.*`
  );
  return rows[0] || null;
}

async function processPending(limit = 10) {
  for (let i = 0; i < limit; i++) {
    const item = await claimNext();
    if (!item) return;
    if (item.event_type === 'REMINDER') {
      const { rows } = await pool.query('SELECT status,revision FROM bookings WHERE id=$1', [item.booking_id]);
      const current = rows[0];
      const setting = await policy.getPolicy(pool, 'REMINDER');
      if (!current || !['PENDING','CONFIRMED'].includes(current.status) ||
          item.idempotency_key !== `line-group/${item.booking_id}/${current.revision}/REMINDER` || !setting.enabled) {
        await pool.query("UPDATE notification_events SET status='SKIPPED',failure_reason='BOOKING_CHANGED' WHERE id=$1", [item.id]);
        continue;
      }
    }
    const outcome = await pushToGroup(item.message_preview, item.recipient_id, item.retry_key);
    const withinRetryWindow = Date.now() - new Date(item.created_at).getTime() < 23 * 60 * 60 * 1000;
    const retry = !outcome.accepted && outcome.retryable && item.attempt_count < 6 && withinRetryWindow;
    const delay = Math.min(300, 2 ** item.attempt_count * 5);
    await pool.query(
      `UPDATE notification_events SET status=$2,response_code=$3,failure_reason=$4,
        scheduled_at=CASE WHEN $2='RETRY' THEN now()+($5::int * interval '1 second') ELSE scheduled_at END
       WHERE id=$1`,
      [item.id, outcome.accepted ? 'ACCEPTED' : retry ? 'RETRY' : 'FAILED',
        outcome.statusCode ? String(outcome.statusCode) : '', outcome.error || '', delay]
    );
  }
}

module.exports = {
  buildBookingMessage, buildUpdateMessage, buildCancelMessage,
  enqueueGroup, cancelReminder, scheduleReminder, previewManual, resendManual,
  processPending, pushToGroup, isConfigured,
};
