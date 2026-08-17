/**
 * LINE Bot webhook（預留骨架，之後串接）。
 *
 * 之後要做的事：
 *   1. LINE Developers 建立 Messaging API channel，
 *      webhook URL 設成 https://<你的網域>/webhook/line
 *   2. 在環境變數填 LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN
 *   3. 在 handleEvent() 裡實作：查詢空位、快速預約、預約前一天提醒等
 *
 * 簽名驗證已實作；secret 未設定時 webhook 只回 200、不處理任何事件。
 */
const express = require('express');
const crypto = require('crypto');

const router = express.Router();

function verifySignature(req) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return false;
  const signature = req.get('X-Line-Signature') || '';
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('base64');
  return signature.length > 0 &&
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function handleEvent(event) {
  // bot 被邀進群組時，把 groupId 印出來 → 填到環境變數 LINE_GROUP_ID
  if (event.type === 'join' && event.source && event.source.type === 'group') {
    console.log('★ LINE bot 已加入群組，LINE_GROUP_ID =', event.source.groupId);
    return;
  }
  // 群組內任何訊息也會帶 groupId（bot 已在群裡但錯過 join log 時用這個看）
  if (event.type === 'message' && event.source && event.source.type === 'group') {
    console.log('LINE 群組訊息，groupId =', event.source.groupId);
    return;
  }
  // TODO: 之後在這裡處理一對一 message / follow / postback 等事件
  console.log('LINE event:', event.type);
}

router.post('/', async (req, res) => {
  if (!process.env.LINE_CHANNEL_SECRET) return res.sendStatus(200); // 尚未啟用
  if (!verifySignature(req)) return res.sendStatus(401);

  const events = (req.body && req.body.events) || [];
  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error('LINE event 處理失敗：', err);
    }
  }
  res.sendStatus(200);
});

module.exports = router;
