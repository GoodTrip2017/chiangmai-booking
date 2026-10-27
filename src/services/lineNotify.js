/**
 * 新預約自動推播到工作群組（LINE Messaging API push message）。
 * LINE_CHANNEL_ACCESS_TOKEN 或 LINE_GROUP_ID 未設定時直接跳過，不影響預約流程。
 */
const dt = require('../util/datetime');
const { pool } = require('../db');

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

async function enqueueGroup(client, booking, eventType, message) {
  const recipient = process.env.LINE_GROUP_ID || '';
  const configured = isConfigured();
  await client.query(
    `INSERT INTO notification_events (booking_id,event_type,recipient_kind,recipient_id,idempotency_key,status,
      failure_reason,message_preview) VALUES ($1,$2,'LINE_GROUP',$3,$4,$5,$6,$7) ON CONFLICT (idempotency_key) DO NOTHING`,
    [booking.id, eventType, recipient, `line-group/${booking.id}/${booking.revision}/${eventType}`,
      configured ? 'QUEUED' : 'FAILED', configured ? '' : 'NOT_CONFIGURED', message]
  );
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
  enqueueGroup, processPending, pushToGroup, isConfigured,
};
