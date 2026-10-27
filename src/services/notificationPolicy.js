const { pool } = require('../db');
const { userError } = require('../util/errors');
const dt = require('../util/datetime');

const EVENTS = Object.freeze(['BOOKING_CONFIRMED', 'BOOKING_UPDATED', 'BOOKING_CANCELLED', 'REMINDER']);
const VARIABLES = Object.freeze(['booking_id', 'name', 'date', 'time', 'guests', 'email', 'line', 'note', 'previous_date', 'previous_time']);

function validateTemplate(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw userError('訊息範本格式不正確 / Invalid notification template.');
  }
  for (const match of value.matchAll(/\{\{([^{}]*)\}\}/g)) {
    if (!VARIABLES.includes(match[1])) throw userError('訊息範本有不支援的變數 / Unsupported template variable.');
  }
  if (value.replace(/\{\{[^{}]*\}\}/g, '').includes('{{') || value.replace(/\{\{[^{}]*\}\}/g, '').includes('}}')) {
    throw userError('訊息範本變數格式不正確 / Invalid template placeholder.');
  }
  return value.trim();
}

function render(template, booking, previous) {
  const values = {
    booking_id: booking.id, name: booking.name, date: booking.date, time: booking.slot,
    guests: booking.pax, email: booking.email || '', line: booking.line || '', note: booking.note || '',
    previous_date: previous?.date || booking.date, previous_time: previous?.slot || booking.slot,
  };
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_, key) => String(values[key] ?? ''));
}

async function getPolicy(client, eventType) {
  if (!EVENTS.includes(eventType)) throw userError('通知事件不正確 / Invalid notification event.');
  const { rows } = await client.query('SELECT * FROM notification_settings WHERE event_type=$1', [eventType]);
  if (!rows[0]) throw new Error('Notification setting missing: ' + eventType);
  return rows[0];
}

async function listPolicies() {
  const { rows } = await pool.query('SELECT * FROM notification_settings ORDER BY event_type');
  return rows;
}

async function updatePolicy(eventType, input) {
  if (!EVENTS.includes(eventType)) throw userError('通知事件不正確 / Invalid notification event.');
  if (typeof input?.enabled !== 'boolean') throw userError('啟用狀態不正確 / Invalid enabled setting.');
  const zh = validateTemplate(input.templateZh);
  const en = validateTemplate(input.templateEn);
  const minutes = input.reminderMinutes;
  if (!Number.isSafeInteger(minutes) || minutes < 30 || minutes > 10080) throw userError('提醒時間須為 30 至 10080 分鐘 / Invalid reminder lead time.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'UPDATE notification_settings SET enabled=$2,template_zh=$3,template_en=$4,reminder_minutes=$5,updated_at=now() WHERE event_type=$1 RETURNING *',
      [eventType, input.enabled, zh, en, minutes]
    );
    if (eventType === 'REMINDER') await reconcileReminders(client, rows[0]);
    await client.query('COMMIT');
    return rows[0];
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

async function reconcileReminders(client, setting) {
  if (!setting.enabled || !process.env.LINE_CHANNEL_ACCESS_TOKEN || !process.env.LINE_GROUP_ID) {
    await client.query("UPDATE notification_events SET status='SKIPPED',failure_reason='POLICY_DISABLED' WHERE event_type='REMINDER' AND status IN ('QUEUED','RETRY')");
    return;
  }
  const { rows } = await client.query("SELECT * FROM bookings WHERE status IN ('PENDING','CONFIRMED') AND date::date >= (now() AT TIME ZONE 'Asia/Bangkok')::date ORDER BY date,slot,id");
  for (const booking of rows) {
    const sendAt = new Date(dt.toUtcMs(booking.date, booking.slot.slice(0, 5)) - setting.reminder_minutes * 60000);
    if (sendAt.getTime() <= Date.now()) continue;
    const text = preview(setting, booking);
    if (text.length > 5000) continue;
    await client.query(
      `INSERT INTO notification_events (booking_id,event_type,recipient_kind,recipient_id,idempotency_key,status,
        failure_reason,message_preview,scheduled_at) VALUES ($1,'REMINDER','LINE_GROUP',$2,$3,'QUEUED','',$4,$5)
       ON CONFLICT (idempotency_key) DO UPDATE SET scheduled_at=EXCLUDED.scheduled_at,
         message_preview=EXCLUDED.message_preview,recipient_id=EXCLUDED.recipient_id,
         status='QUEUED',failure_reason=''
       WHERE notification_events.status IN ('QUEUED','RETRY','SKIPPED')`,
      [booking.id, process.env.LINE_GROUP_ID, `line-group/${booking.id}/${booking.revision}/REMINDER`, text, sendAt]
    );
  }
}

function preview(policy, booking, previous) {
  return [render(policy.template_zh, booking, previous), render(policy.template_en, booking, previous)].join('\n\n');
}

module.exports = { EVENTS, VARIABLES, validateTemplate, render, preview, getPolicy, listPolicies, updatePolicy };
