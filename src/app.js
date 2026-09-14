const path = require('node:path');
const express = require('express');
const { pool } = require('./db');
const auth = require('./services/auth');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000');
    const route = req.path.toLowerCase();
    if (route.startsWith('/admin') || route.startsWith('/api') || route === '/healthz') res.set('Cache-Control', 'no-store');
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && (route.startsWith('/api') || route.startsWith('/webhook')) && !req.is('application/json')) {
      return res.status(415).json({ error: '請使用 JSON 格式送出資料。' });
    }
    next();
  });
  app.use(express.json({ limit: '32kb', inflate: false, verify: (req, res, buf) => {
    if (req.path.toLowerCase().startsWith('/webhook/line')) req.rawBody = buf;
  } }));
  app.use((req, res, next) => {
    if (req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
      return res.status(400).json({ error: '請求格式不正確。' });
    }
    next();
  });
  app.get('/admin.html', (req, res) => res.redirect(303, '/admin'));
  app.get('/admin/login', (req, res) => {
    if (req.url.includes('?')) return res.redirect(303, '/admin/login');
    res.sendFile(path.join(__dirname, '..', 'views', 'login.html'));
  });
  app.get('/admin', async (req, res, next) => {
    try {
      if (req.url.includes('?')) return res.redirect(303, '/admin');
      if (!await auth.sessionFor(req)) return res.redirect(303, '/admin/login');
      res.sendFile(path.join(__dirname, '..', 'views', 'admin.html'));
    } catch (err) { next(err); }
  });
  app.post('/api/admin/login', auth.requireSameOrigin, auth.login);
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api', require('./routes/public'));
  app.use('/webhook/line', require('./routes/line'));
  app.get('/healthz', async (req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true }); }
    catch { res.status(503).json({ ok: false }); }
  });
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use((req, res) => res.status(404).json({ error: '找不到這個頁面。' }));
  app.use((err, req, res, next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status >= 500) console.error('請求處理失敗：', err.code || err.name || 'UNKNOWN');
    const message = err.type === 'entity.parse.failed' ? '請求格式不正確。'
      : status >= 500 ? '服務暫時無法處理，請稍後再試。' : err.message;
    if (status === 429) res.set('Retry-After', String(err.retryAfter || 900));
    res.status(status).json({ error: message, ...(err.code === 'GROUP_CONTACT_REQUIRED' ? { code: err.code, contactUrl: err.contactUrl } : {}) });
  });
  return app;
}
module.exports = { createApp };
