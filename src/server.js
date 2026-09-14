require('dotenv').config();
const { migrate } = require('./db/migrate');
const { pool } = require('./db');
const { assertAuthConfig } = require('./services/auth');
const { createApp } = require('./app');

async function start() {
  if (!process.env.DATABASE_URL) throw new Error('請設定 DATABASE_URL。');
  assertAuthConfig();
  if (process.env.NODE_ENV === 'production') {
    const origin = process.env.APP_ORIGIN || (process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
    if (!origin || !origin.startsWith('https://') || new URL(origin).origin !== origin) {
      throw new Error('請設定 APP_ORIGIN 為正式 HTTPS 網站來源（不含結尾斜線），或先產生 Railway 網域。');
    }
    process.env.APP_ORIGIN = origin;
  }
  await migrate();
  const server = createApp().listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('預約系統已啟動。'));
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    const timeout = setTimeout(() => process.exit(1), 15000);
    timeout.unref();
    server.close(async () => { await pool.end(); clearTimeout(timeout); process.exit(0); });
    server.closeIdleConnections();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
start().catch(err => {
  console.error('啟動失敗：', err.code || (err.message.includes('請') ? err.message : err.name));
  process.exit(1);
});
