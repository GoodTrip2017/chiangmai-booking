const crypto = require('node:crypto');
const { ipKeyGenerator } = require('express-rate-limit');
const { pool } = require('../db');
const { userError } = require('../util/errors');
const { clientIp } = require('../util/clientIp');

// 合併 IPv6 /56，避免同一網段切換地址繞過限制；資料庫不記錄原始 IP。
function ipDigest(ip) {
  return crypto.createHash('sha256').update(ipKeyGenerator(ip || 'unknown', 56)).digest('hex');
}
async function consumeLimit(bucket, limit, windowMs, message, loginStore = false) {
  // 表名只由程式內部布林值選擇，所有請求資料均使用 SQL 參數。
  const table = loginStore ? 'admin_login_limits' : 'request_limits';
  const { rows } = await pool.query(
    `INSERT INTO ${table} (bucket, attempts, expires_at)
     VALUES ($1, 1, now() + $2 * interval '1 millisecond')
     ON CONFLICT (bucket) DO UPDATE SET
       attempts = CASE WHEN ${table}.expires_at <= now() THEN 1 ELSE LEAST(${table}.attempts + 1, $3 + 1) END,
       expires_at = CASE WHEN ${table}.expires_at <= now() THEN now() + $2 * interval '1 millisecond' ELSE ${table}.expires_at END
     RETURNING attempts, expires_at`, [bucket, windowMs, limit]
  );
  // 隨機清理過期桶，避免每次登入掃描全表；期限索引限制清理成本。
  if (crypto.randomInt(100) === 0) await pool.query(`DELETE FROM ${table} WHERE expires_at <= now()`);
  if (rows[0].attempts > limit) {
    throw Object.assign(userError(message, 429), { retryAfter: Math.max(1, Math.ceil((rows[0].expires_at.getTime() - Date.now()) / 1000)) });
  }
}
async function limitBooking(req, res, next) {
  try {
    const ip = ipDigest(clientIp(req));
    await consumeLimit(`booking-minute:${ip}`, 3, 60000, '操作太頻繁，請稍候一分鐘再試。');
    await consumeLimit(`booking-day:${ip}`, 20, 86400000, '今日預約次數已達上限，請改用 LINE 與我們聯絡。');
    next();
  } catch (err) { next(err); }
}
module.exports = { consumeLimit, ipDigest, limitBooking };
