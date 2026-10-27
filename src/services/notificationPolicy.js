const { pool } = require('../db');
const { userError } = require('../util/errors');

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
  const { rows } = await pool.query(
    'UPDATE notification_settings SET enabled=$2,template_zh=$3,template_en=$4,reminder_minutes=$5,updated_at=now() WHERE event_type=$1 RETURNING *',
    [eventType, input.enabled, zh, en, minutes]
  );
  return rows[0];
}

function preview(policy, booking, previous) {
  return [render(policy.template_zh, booking, previous), render(policy.template_en, booking, previous)].join('\n\n');
}

module.exports = { EVENTS, VARIABLES, validateTemplate, render, preview, getPolicy, listPolicies, updatePolicy };
