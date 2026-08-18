const path = require('path');
const express = require('express');
require('dotenv').config();

const { migrate } = require('./db/migrate');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const lineRoutes = require('./routes/line');
const { isAdminToken } = require('./routes/admin');

const app = express();

// Railway 的反向代理之後才是真實客戶端 IP，頻率限制需要這個設定才抓得準
app.set('trust proxy', 1);

// 保留原始 body 供 LINE webhook 驗簽
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// 前台頁（/）與靜態資源
app.use(express.static(path.join(__dirname, '..', 'public')));

// 後台頁：/admin?token=xxx（token 不對就擋在頁面外）
app.get('/admin', (req, res) => {
  if (!isAdminToken(String(req.query.token || ''))) {
    return res.status(401).send(
      '<div style="font-family:sans-serif;padding:40px;text-align:center">' +
      '<h2>無權限</h2><p>此頁面僅供工作人員使用，請使用正確的後台連結。</p></div>'
    );
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);
app.use('/webhook/line', lineRoutes);

app.get('/healthz', (req, res) => res.json({ ok: true }));

// 統一錯誤格式：{ error: '訊息' }
app.use((err, req, res, next) => {
  const status = err.status || 400;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || '發生錯誤，請稍後再試。' });
});

const PORT = Number(process.env.PORT || 3000);

migrate()
  .then(() => {
    app.listen(PORT, () => console.log(`預約系統啟動：http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('資料庫初始化失敗：', err);
    process.exit(1);
  });
