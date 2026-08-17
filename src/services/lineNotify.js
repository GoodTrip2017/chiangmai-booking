/**
 * 新預約自動推播到工作群組（LINE Messaging API push message）。
 * LINE_CHANNEL_ACCESS_TOKEN 或 LINE_GROUP_ID 未設定時直接跳過，不影響預約流程。
 */
const dt = require('../util/datetime');

function isConfigured() {
  return !!(process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_GROUP_ID);
}

const SOURCE_LABEL = { WEB: '網路預約', WALK_IN: '現場上門', LINE: 'LINE', PHONE: '電話' };

function bookingDetailLines(booking) {
  const lines = [
    `${booking.name} x${booking.pax} 人`,
    `${dt.formatDateZh(booking.date)} ${booking.slot}`,
  ];
  const contact = [booking.line && `LINE: ${booking.line}`, booking.email]
    .filter(Boolean).join(' · ');
  if (contact) lines.push(contact);
  return lines;
}

function buildBookingMessage(booking) {
  const lines = ['🔔 新預約', ...bookingDetailLines(booking)];
  if (booking.first_time === '是') lines.push('⭐ 第一次接觸');
  lines.push(`來源：${SOURCE_LABEL[booking.source] || booking.source}`);
  if (booking.note) lines.push(`備註：${booking.note}`);
  return lines.join('\n');
}

/** prev = 修改前的資料，時段有變動時顯示「原時段」方便店員對照 */
function buildUpdateMessage(booking, prev) {
  const lines = ['✏️ 預約修改', ...bookingDetailLines(booking)];
  if (prev && (prev.date !== booking.date || prev.slot !== booking.slot)) {
    lines.push(`原時段：${dt.formatDateZh(prev.date)} ${prev.slot}`);
  }
  if (booking.note) lines.push(`備註：${booking.note}`);
  return lines.join('\n');
}

function buildCancelMessage(booking) {
  return ['❌ 預約取消', ...bookingDetailLines(booking)].join('\n');
}

/** 推播文字訊息到群組。回傳是否成功；失敗只記 log，不往外丟錯。 */
async function pushToGroup(text) {
  if (!isConfigured()) return false;
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to: process.env.LINE_GROUP_ID,
        messages: [{ type: 'text', text }],
      }),
    });
    if (!res.ok) {
      console.error('LINE 推播失敗：', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('LINE 推播失敗：', err);
    return false;
  }
}

async function notifyNewBooking(booking) {
  return pushToGroup(buildBookingMessage(booking));
}

async function notifyUpdatedBooking(booking, prev) {
  return pushToGroup(buildUpdateMessage(booking, prev));
}

async function notifyCancelledBooking(booking) {
  return pushToGroup(buildCancelMessage(booking));
}

module.exports = {
  notifyNewBooking, notifyUpdatedBooking, notifyCancelledBooking,
  pushToGroup, isConfigured,
};
