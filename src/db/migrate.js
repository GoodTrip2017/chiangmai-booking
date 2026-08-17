/** 執行 schema.sql（idempotent，可重複執行）。伺服器啟動時也會自動跑一次。 */
const fs = require('fs');
const path = require('path');
const { pool } = require('./index');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

if (require.main === module) {
  migrate()
    .then(() => { console.log('資料庫 schema 已就緒。'); process.exit(0); })
    .catch((err) => { console.error('migrate 失敗：', err); process.exit(1); });
}

module.exports = { migrate };
