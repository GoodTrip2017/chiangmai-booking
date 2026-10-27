/**
 * 預約確認信。沿用原本的文案。
 * 使用 Resend HTTPS API；通知結果不影響已成立的預約。
 */
const { CONFIG } = require('../config');
const dt = require('../util/datetime');

function isConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function mailSubject(booking) {
  return `【${CONFIG.SENDER_NAME}】預約確認 / Booking confirmation — ` +
    `${dt.formatDateZh(booking.date)} ${dt.formatTimeZh(dt.getSlotDef(booking.slot).start)}`;
}

function arrivalDeadlineEn(booking) {
  const start = dt.getSlotDef(booking.slot).start;
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(dt.toUtcMs(booking.date, start) + CONFIG.GRACE_MINUTES * 60000));
}

function buildConfirmationText(booking) {
  const deadline = dt.graceDeadlineZh(booking.date, booking.slot);
  const deadlineEn = arrivalDeadlineEn(booking);
  return [
    `${booking.name} 您好 / Hello ${booking.name},`,
    '',
    '感謝您的預約，您的到店時段已確認。 / Your visit time is confirmed.',
    '',
    '以下是您的預約詳細資訊 / Your booking details:',
    '',
    `• 預約編號 / Booking ID: ${booking.id}`,
    `• 活動名稱 / Service: ${CONFIG.EVENT_NAME}`,
    `• 預約日期 / Visit date: ${dt.formatDateZh(booking.date)}`,
    `• 預約時段 / Time slot: ${dt.slotLabelZh(booking.slot)} (GMT+7)`,
    `• 到訪人數 / Guests: ${booking.pax}`,
    `• 地點 / Venue: ${CONFIG.VENUE_NAME}`,
    `• 地址 / Address: ${CONFIG.VENUE_ADDRESS}`,
    `• 地圖 / Map: ${CONFIG.MAP_URL}`,
    '',
    '重要報到須知 / Arrival information:',
    '',
    `1. 座位保留 / Arrival window: 請於預約開始後 ${CONFIG.GRACE_MINUTES} 分鐘內抵達。 / Please arrive within ${CONFIG.GRACE_MINUTES} minutes of your start time.`,
    '',
    `2. 逾時處理： 由於現場空間有限且可能會有其他客人預約，若您未能於 ${deadline} 前 抵達，` +
      '請透過 LINE 聯絡店員；逾時座位將由店員依現場情況安排，可能需要重新候位。',
    `   Please arrive by ${deadlineEn} (Chiang Mai time). If delayed, contact staff on LINE. Late arrivals are handled based on availability.`,
    '',
    `3. 聯繫方式： 如行程有變動，或交通上的延誤，歡迎隨時透過 LINE (${CONFIG.LINE_URL}) ` +
      '與我們聯絡，確認是否能調整。',
    `   If your plans change, contact us on LINE (${CONFIG.LINE_URL}) to ask about available alternatives.`,
    '',
    '期待在清邁與您見面。 / We look forward to welcoming you in Chiang Mai.',
    '',
    `${CONFIG.SENDER_NAME} 敬上`,
  ].join('\n');
}

function buildConfirmationHtml(booking) {
  const deadline = dt.graceDeadlineZh(booking.date, booking.slot);
  const deadlineEn = arrivalDeadlineEn(booking);
  const row = (label, value) =>
    `<li style="margin:6px 0"><strong>${label}：</strong> ${value}</li>`;

  return '' +
    '<div style="font-family:-apple-system,\'Noto Sans TC\',\'Microsoft JhengHei\',sans-serif;' +
    'font-size:15px;line-height:1.75;color:#222;max-width:620px">' +
      `<p>${escapeHtml(booking.name)} 您好 / Hello ${escapeHtml(booking.name)},</p>` +
      '<p>感謝您的預約，您的到店時段已確認。 / Your visit time is confirmed.</p>' +
      '<p>以下是您的預約詳細資訊 / Your booking details:</p>' +
      '<ul style="list-style:none;padding-left:0">' +
        row('預約編號 / Booking ID', escapeHtml(booking.id)) +
        row('活動名稱 / Service', escapeHtml(CONFIG.EVENT_NAME)) +
        row('預約日期 / Visit date', `<strong>${dt.formatDateZh(booking.date)}</strong>`) +
        row('預約時段 / Time slot', `<strong>${dt.slotLabelZh(booking.slot)} (GMT+7)</strong>`) +
        row('到訪人數 / Guests', `${escapeHtml(booking.pax)} 人 / guests`) +
        row('地點 / Venue', escapeHtml(CONFIG.VENUE_NAME)) +
        row('地址 / Address', escapeHtml(CONFIG.VENUE_ADDRESS)) +
        row('地圖 / Map', `<a href="${CONFIG.MAP_URL}">開啟 Google 地圖 / Open Google Maps</a>`) +
      '</ul>' +
      '<p style="margin-top:24px"><strong>重要報到須知 / Arrival information:</strong></p>' +
      '<ol style="padding-left:20px">' +
        `<li style="margin:8px 0"><strong>座位保留 / Arrival window:</strong> 請於預約開始後 ${CONFIG.GRACE_MINUTES} 分鐘內抵達。 / Please arrive within ${CONFIG.GRACE_MINUTES} minutes of your start time.</li>` +
        '<li style="margin:8px 0"><strong>逾時處理：</strong> 由於現場空間有限且可能會有其他客人預約，' +
          `若您未能於 <strong>${deadline} 前</strong> 抵達，請透過 LINE 聯絡店員；逾時座位將由店員依現場情況安排，` +
          `可能需要重新候位。 / Please arrive by ${deadlineEn} (Chiang Mai time). If delayed, contact staff on LINE; late arrivals depend on availability.</li>` +
        '<li style="margin:8px 0"><strong>聯繫方式：</strong> 如行程有變動，或交通上的延誤，' +
          `歡迎隨時透過 <a href="${CONFIG.LINE_URL}">LINE</a> 與我們聯絡，確認是否能調整。 / Contact us on LINE if your plans change.</li>` +
      '</ol>' +
      '<p>期待在清邁與您見面。 / We look forward to welcoming you in Chiang Mai.</p>' +
      `<p style="margin-top:20px">${escapeHtml(CONFIG.SENDER_NAME)} 敬上</p>` +
    '</div>';
}

/** ACCEPTED 代表寄信服務已接受，不保證信箱投遞成功。 */
async function sendConfirmation(booking, requestKey) {
  if (!booking.email) return 'NO_EMAIL';
  if (!isConfigured()) return 'NOT_CONFIGURED';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'chiangmai-booking/1.1',
      'Idempotency-Key': requestKey || `confirmation/${booking.id}`,
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM,
      ...(process.env.MAIL_REPLY_TO ? { reply_to: process.env.MAIL_REPLY_TO } : {}),
      to: [booking.email],
      subject: mailSubject(booking),
      text: buildConfirmationText(booking),
      html: buildConfirmationHtml(booking),
    }),
  });
  if (!response.ok) throw Object.assign(new Error('寄信服務暫時無法接受請求。'), { code: `MAIL_HTTP_${response.status}` });
  const result = await response.json();
  if (!result.id) throw Object.assign(new Error('寄信服務回應不完整。'), { code: 'MAIL_RESPONSE_INVALID' });
  return 'ACCEPTED';
}
module.exports = { sendConfirmation, isConfigured, buildConfirmationHtml, buildConfirmationText };
