const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { pool } = require('../db');
const { userError } = require('../util/errors');
const { consumeLimit, ipDigest } = require('./rateLimits');
const { clientIp } = require('../util/clientIp');
const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 8 * 60 * 60 * 1000;
// OWASP 的低記憶體 scrypt 組合；明確版本化參數，拒絕舊的弱設定。
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 };
const HASH_PATTERN = /^scrypt:16384:8:5:([a-f0-9]{32}):([a-f0-9]{128})$/;
let activeChecks = 0;

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function secureEqual(a, b) {
  const x = Buffer.from(a || '');
  const y = Buffer.from(b || '');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function cookieName() { return process.env.NODE_ENV === 'production' ? '__Host-admin_session' : 'admin_session'; }
function cookieOptions() {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/' };
}
function passwordHash() { return process.env.ADMIN_PASSWORD_HASH || ''; }
function assertAuthConfig() {
  if (!HASH_PATTERN.test(passwordHash())) throw new Error('請先設定有效的 ADMIN_PASSWORD_HASH（npm run admin:password）。');
}
async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 256) {
    throw userError('密碼請使用 16–256 個字元 / Password must be 16–256 characters.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt:16384:8:5:${salt}:${key.toString('hex')}`;
}
async function checkPassword(password, storedHash = passwordHash()) {
  const match = storedHash.match(HASH_PATTERN);
  if (!match || typeof password !== 'string' || password.length < 16 || password.length > 256) return false;
  if (activeChecks >= 2) throw Object.assign(userError('登入忙碌中，請稍後再試 / Login is busy; try again shortly.', 429), { retryAfter: 5 });
  activeChecks++;
  try {
    const key = await scrypt(password, match[1], 64, SCRYPT_OPTIONS);
    return secureEqual(key.toString('hex'), match[2]);
  } finally { activeChecks--; }
}

// 限制保存在資料庫，重新部署或多個服務實例都不會重設限制。
async function limitLogin(ip) {
  for (const [bucket, limit] of [[`ip:${ipDigest(ip)}`, 5], ['global', 60]]) {
    await consumeLimit(bucket, limit, 900000, '登入嘗試過於頻繁，請 15 分鐘後再試 / Too many login attempts; try again in 15 minutes.', true);
  }
}
function requireSameOrigin(req, res, next) {
  const expected = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
  if (req.get('origin') !== expected || !req.is('application/json') || req.get('Sec-Fetch-Site') === 'cross-site') {
    return res.status(403).json({ error: '請從本站後台操作 / Use this site to make the change.' });
  }
  next();
}
async function login(req, res, next) {
  try {
    await limitLogin(clientIp(req));
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    if (username && !/^[a-z0-9._-]{3,40}$/.test(username)) throw userError('帳號或密碼不正確 / Invalid credentials.', 401);
    const account = username ? (await pool.query('SELECT * FROM staff_accounts WHERE username=$1 AND active=true', [username])).rows[0] : null;
    const hash = username ? (account?.password_hash || passwordHash()) : passwordHash();
    if (!await checkPassword(req.body?.password, hash) || (username && !account)) throw userError('帳號或密碼不正確 / Invalid credentials.', 401);
    const token = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(32).toString('hex');
    await pool.query('DELETE FROM admin_sessions WHERE expires_at <= now()');
    await pool.query(
      'INSERT INTO admin_sessions (token_hash, csrf_token, credential_version, expires_at, account_id, role) VALUES ($1, $2, $3, $4, $5, $6)',
      [digest(token), csrfToken, digest(hash), new Date(Date.now() + SESSION_MS), account?.id || null, account?.role || 'ADMIN']
    );
    // 登入時一定換發憑證，不沿用客戶端提供的 session。
    const old = readToken(req);
    if (old) await pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [digest(old)]);
    res.cookie(cookieName(), token, { ...cookieOptions(), maxAge: SESSION_MS });
    res.json({ ok: true, csrfToken });
  } catch (err) { next(err); }
}
function readToken(req) {
  const prefix = `${cookieName()}=`;
  const values = (req.get('cookie') || '').split(';').map(s => s.trim()).filter(s => s.startsWith(prefix));
  const token = values.length === 1 ? values[0].slice(prefix.length) : '';
  return /^[a-f0-9]{64}$/.test(token) ? token : '';
}
async function sessionFor(req) {
  const token = readToken(req);
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT s.token_hash,s.csrf_token,s.role,s.account_id,s.credential_version,
      a.username,a.display_name,a.password_hash,a.active,a.role AS current_role
     FROM admin_sessions s LEFT JOIN staff_accounts a ON a.id=s.account_id
     WHERE s.token_hash=$1 AND s.expires_at>now()`,
    [digest(token)]
  );
  const session = rows[0];
  if (!session) return null;
  const currentHash = session.account_id ? (session.active ? session.password_hash : '') : passwordHash();
  if (!currentHash || (session.account_id && session.role !== session.current_role)) return null;
  return secureEqual(session.credential_version, digest(currentHash)) ? session : null;
}
async function requireAdmin(req, res, next) {
  try {
    req.adminSession = await sessionFor(req);
    if (!req.adminSession) return res.status(401).json({ error: '登入已失效，請重新登入 / Session expired; sign in again.' });
    next();
  } catch (err) { next(err); }
}
function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  requireSameOrigin(req, res, () => {
    if (!secureEqual(req.get('X-CSRF-Token'), req.adminSession.csrf_token)) {
      return res.status(403).json({ error: '操作驗證已失效，請重新整理 / Request verification expired; refresh the page.' });
    }
    next();
  });
}
function requireRole(...roles) {
  return (req, res, next) => roles.includes(req.adminSession?.role)
    ? next() : res.status(403).json({ error: '此帳號沒有操作權限 / Insufficient permissions.' });
}
async function createAccount(input) {
  const username = typeof input?.username === 'string' ? input.username.trim().toLowerCase() : '';
  const displayName = typeof input?.displayName === 'string' ? input.displayName.trim() : '';
  if (!/^[a-z0-9._-]{3,40}$/.test(username) || !displayName || displayName.length > 80 || /[\u0000-\u001f\u007f]/.test(displayName)) throw userError('帳號或顯示名稱格式不正確 / Invalid account fields.');
  if (!['ADMIN','STAFF','ANALYST'].includes(input.role)) throw userError('角色不正確 / Invalid role.');
  const hash = await hashPassword(input.password);
  try {
    const { rows } = await pool.query(
      'INSERT INTO staff_accounts(username,display_name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id,username,display_name,role,active,created_at',
      [username, displayName, input.role, hash]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw userError('帳號已存在 / Username already exists.', 409);
    throw err;
  }
}
async function setAccountActive(id, active) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || typeof active !== 'boolean') throw userError('帳號資料不正確 / Invalid account.');
  const { rows } = await pool.query('UPDATE staff_accounts SET active=$2,updated_at=now() WHERE id=$1 RETURNING id,username,display_name,role,active', [id, active]);
  if (!rows[0]) throw userError('找不到帳號 / Account not found.', 404);
  return rows[0];
}
async function logout(req, res, next) {
  try {
    await pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [req.adminSession.token_hash]);
    res.clearCookie(cookieName(), cookieOptions());
    res.json({ ok: true });
  } catch (err) { next(err); }
}
module.exports = { assertAuthConfig, hashPassword, sessionFor, requireAdmin, requireCsrf, requireRole, requireSameOrigin, login, logout, createAccount, setAccountActive };
