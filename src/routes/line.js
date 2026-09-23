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
const { userError } = require('../util/errors');
const { pool } = require('../db');

const router = express.Router();

function verifySignature(req) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return false;
  const signature = req.get('X-Line-Signature') || '';
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('base64');
  return signature.length > 0 &&
    Buffer.byteLength(signature) === Buffer.byteLength(expected) &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function handleEvent(event) {
  // 驗簽通過後只保留群組 ID；不保存對話、成員資料或訊息內容。
  if (['join', 'message'].includes(event.type) && event.source?.type === 'group' &&
      /^C[0-9a-f]{32}$/i.test(event.source.groupId || '')) {
    await pool.query('INSERT INTO line_group_candidates (group_id) VALUES ($1) ON CONFLICT (group_id) DO UPDATE SET seen_at = now()', [event.source.groupId]);
    return;
  }
  // TODO: 之後在這裡處理一對一 message / follow / postback 等事件
}

router.post('/', async (req, res, next) => {
  try {
    if (!process.env.LINE_CHANNEL_SECRET) return res.sendStatus(200); // 尚未啟用
    if (!verifySignature(req)) return res.sendStatus(401);
    const events = req.body?.events;
    if (!Array.isArray(events) || events.length > 100 || events.some(event =>
      !event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string' || event.type.length > 80)) {
      throw userError('Webhook 格式不正確。');
    }
    for (const event of events) await handleEvent(event);
    res.sendStatus(200);
  } catch (err) { next(err); }
});

module.exports = router;
