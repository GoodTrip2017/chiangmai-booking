const tls = require('node:tls');

function connectionConfig(env = process.env) {
  let url;
  try { if (env.DATABASE_URL) url = new URL(env.DATABASE_URL); }
  catch { throw new Error('請設定有效的 DATABASE_URL。'); }
  if (url && !['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('請設定 PostgreSQL 格式的 DATABASE_URL。');
  const flag = (env.DATABASE_SSL || '').toLowerCase();
  if (!['', 'true', 'false'].includes(flag)) throw new Error('請將 DATABASE_SSL 設為 true 或 false。');
  if (env.NODE_ENV === 'production' && !flag) throw new Error('請明確設定 DATABASE_SSL（Railway 內網 false，外部 TLS 連線 true）。');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('請移除 NODE_TLS_REJECT_UNAUTHORIZED=0，保留 TLS 憑證驗證。');
  const sslKeys = url ? [...url.searchParams.keys()].filter(key => /^ssl|^uselibpqcompat$/i.test(key)) : [];
  // pg 會以 URL 的 sslmode 覆蓋 ssl 物件（包含 CA 與 rejectUnauthorized）。
  // 統一由明確的環境設定管理，避免 no-verify/disable 靜默降低防護。
  if (sslKeys.length) throw new Error('請移除 DATABASE_URL 中的 SSL 參數，改用 DATABASE_SSL 與 DATABASE_CA_CERT。');
  return {
    connectionString: env.DATABASE_URL,
    ssl: flag === 'true' ? {
      rejectUnauthorized: true,
      // pg 的 IP 連線不設定 SNI；仍須用實際目標（含 IP）驗證憑證名稱。
      checkServerIdentity: (_, cert) => tls.checkServerIdentity(url?.hostname.replace(/^\[|\]$/g, '') || env.PGHOST || 'localhost', cert),
      ...(env.DATABASE_CA_CERT ? { ca: env.DATABASE_CA_CERT.replace(/\\n/g, '\n') } : {}),
    } : false,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 10,
    statement_timeout: 10000,
  };
}
module.exports = { connectionConfig };
