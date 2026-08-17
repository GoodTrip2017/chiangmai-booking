/**
 * 預約確認信。沿用原本的文案。
 * SMTP 未設定時不寄信（回傳 false），預約流程照常成立。
 */
const nodemailer = require('nodemailer');
const { CONFIG } = require('../config');
const dt = require('../util/datetime');

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function mailSubject(booking) {
  return `【${CONFIG.SENDER_NAME}】預約成功確認 — ` +
    `${dt.formatDateZh(booking.date)} ${dt.formatTimeZh(dt.getSlotDef(booking.slot).start)}`;
}

function buildConfirmationText(booking) {
  const deadline = dt.graceDeadlineZh(booking.date, booking.slot);
  return [
    `${booking.name} 您好，`,
    '',
    '感謝您的預約！我們已為您安排好專屬的飛行體驗。',
    '',
    '以下是您的預約詳細資訊：',
    '',
    `• 活動名稱： ${CONFIG.EVENT_NAME}`,
    `• 預約日期： ${dt.formatDateZh(booking.date)}`,
    `• 預約時段： ${dt.slotLabelZh(booking.slot)} (GMT+7)`,
    `• 到訪人數： ${booking.pax}`,
    `• 地點： ${CONFIG.VENUE_NAME}`,
    `• 地址： ${CONFIG.VENUE_ADDRESS}`,
    `• 地圖連結： ${CONFIG.MAP_URL}`,
    '',
    '⚠️ 重要報到須知：',
    '',
    `1. 座位保留： 我們將為您保留預約時段 ${CONFIG.GRACE_MINUTES} 分鐘。`,
    '',
    `2. 逾時處理： 由於現場空間有限且可能會有其他客人預約，若您未能於 ${deadline} 前 抵達，` +
      '原預約將自動取消，需請您於現場重新候位，敬請見諒。🙇🏻‍♀️🙇🏻‍♂️',
    '',
    `3. 聯繫方式： 如行程有變動，或交通上的延誤，歡迎隨時透過 LINE (${CONFIG.LINE_URL}) ` +
      '與我們聯絡，為您彈性保留調整。',
    '',
    '期待在清邁與您見面，祝您有一場愉快的飛行體驗！🫡',
    '',
    '最後祝您旅途順利愉快🥰❤️',
    '',
    `${CONFIG.SENDER_NAME} 敬上`,
  ].join('\n');
}

function buildConfirmationHtml(booking) {
  const deadline = dt.graceDeadlineZh(booking.date, booking.slot);
  const row = (label, value) =>
    `<li style="margin:6px 0"><strong>${label}：</strong> ${value}</li>`;

  return '' +
    '<div style="font-family:-apple-system,\'Noto Sans TC\',\'Microsoft JhengHei\',sans-serif;' +
    'font-size:15px;line-height:1.75;color:#222;max-width:620px">' +
      `<p>${escapeHtml(booking.name)} 您好，</p>` +
      '<p>感謝您的預約！我們已為您安排好專屬的飛行體驗。</p>' +
      '<p>以下是您的預約詳細資訊：</p>' +
      '<ul style="list-style:none;padding-left:0">' +
        row('活動名稱', escapeHtml(CONFIG.EVENT_NAME)) +
        row('預約日期', `<strong>${dt.formatDateZh(booking.date)}</strong>`) +
        row('預約時段', `<strong>${dt.slotLabelZh(booking.slot)} (GMT+7)</strong>`) +
        row('到訪人數', `${escapeHtml(booking.pax)} 人`) +
        row('地點', escapeHtml(CONFIG.VENUE_NAME)) +
        row('地址', escapeHtml(CONFIG.VENUE_ADDRESS)) +
        row('地圖連結', `<a href="${CONFIG.MAP_URL}">點此開啟 Google 地圖</a>`) +
      '</ul>' +
      '<p style="margin-top:24px"><strong>⚠️ 重要報到須知：</strong></p>' +
      '<ol style="padding-left:20px">' +
        `<li style="margin:8px 0"><strong>座位保留：</strong> 我們將為您保留預約時段 ${CONFIG.GRACE_MINUTES} 分鐘。</li>` +
        '<li style="margin:8px 0"><strong>逾時處理：</strong> 由於現場空間有限且可能會有其他客人預約，' +
          `若您未能於 <strong>${deadline} 前</strong> 抵達，原預約將自動取消，` +
          '需請您於現場重新候位，敬請見諒。🙇🏻‍♀️🙇🏻‍♂️</li>' +
        '<li style="margin:8px 0"><strong>聯繫方式：</strong> 如行程有變動，或交通上的延誤，' +
          `歡迎隨時透過 <a href="${CONFIG.LINE_URL}">LINE</a> 與我們聯絡，為您彈性保留調整。</li>` +
      '</ol>' +
      '<p>期待在清邁與您見面，祝您有一場愉快的飛行體驗！🫡</p>' +
      '<p>最後祝您旅途順利愉快🥰❤️</p>' +
      `<p style="margin-top:20px">${escapeHtml(CONFIG.SENDER_NAME)} 敬上</p>` +
    '</div>';
}

/**
 * 寄出確認信。沒有 Email 或 SMTP 未設定就跳過（回傳 false）。
 * booking 需含 name / pax / date / slot / email。
 */
async function sendConfirmation(booking) {
  if (!booking.email) return false;
  if (!isConfigured()) {
    console.warn('SMTP 未設定，略過寄送確認信。');
    return false;
  }
  await getTransporter().sendMail({
    from: `"${CONFIG.SENDER_NAME}" <${process.env.MAIL_FROM || process.env.SMTP_USER}>`,
    to: booking.email,
    subject: mailSubject(booking),
    text: buildConfirmationText(booking),
    html: buildConfirmationHtml(booking),
  });
  return true;
}

module.exports = { sendConfirmation, isConfigured };
