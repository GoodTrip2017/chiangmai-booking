const { pool } = require('../db');
const { userError } = require('../util/errors');

function field(value, name, max = 80) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw userError(`${name} 格式不正確 / Invalid ${name}.`);
  return value.trim();
}
function code(value) {
  const parsed = field(value, 'code', 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(parsed)) throw userError('合作代碼須為 3–40 個英數字 / Invalid tracking code.');
  return parsed;
}
function payload(input) {
  const name = field(input?.name, 'name', 80);
  if (!name) throw userError('請填寫追蹤連結名稱 / Tracking link name is required.');
  if (!['PARTNER','CAMPAIGN','QR'].includes(input.kind)) throw userError('追蹤類型不正確 / Invalid tracking type.');
  return { code: code(input.code), name, kind: input.kind,
    source: field(input.utmSource || '', 'utm_source'),
    medium: field(input.utmMedium || '', 'utm_medium'),
    campaign: field(input.utmCampaign || '', 'utm_campaign') };
}
async function listTracking() {
  const { rows } = await pool.query('SELECT * FROM tracking_links ORDER BY created_at DESC');
  return rows;
}
async function createTracking(input) {
  const p = payload(input);
  try {
    const { rows } = await pool.query(
      'INSERT INTO tracking_links(code,name,kind,utm_source,utm_medium,utm_campaign) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [p.code,p.name,p.kind,p.source,p.medium,p.campaign]
    );
    return rows[0];
  } catch (err) { if (err.code === '23505') throw userError('追蹤代碼已存在 / Code already exists.', 409); throw err; }
}
async function updateTracking(trackingCode, input) {
  const id = code(trackingCode);
  const name = field(input?.name, 'name', 80);
  if (!name || typeof input?.active !== 'boolean') throw userError('名稱或狀態不正確 / Invalid link settings.');
  const { rows } = await pool.query('UPDATE tracking_links SET name=$2,active=$3 WHERE code=$1 RETURNING *', [id,name,input.active]);
  if (!rows[0]) throw userError('找不到追蹤代碼 / Tracking code not found.', 404);
  return rows[0];
}
function linkFor(row, origin) {
  const url = new URL('/', origin);
  if (row.utm_source) url.searchParams.set('utm_source', row.utm_source);
  if (row.utm_medium) url.searchParams.set('utm_medium', row.utm_medium);
  if (row.utm_campaign) url.searchParams.set('utm_campaign', row.utm_campaign);
  url.searchParams.set('ref', row.code);
  return url.toString();
}
async function resolveTracking(client, data) {
  if (!data.trackingCode) return { partnerCode: '', campaignCode: '' };
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(data.trackingCode)) return { partnerCode: '', campaignCode: '' };
  const { rows } = await client.query('SELECT code,kind FROM tracking_links WHERE code=$1 AND active=true', [data.trackingCode]);
  const row = rows[0];
  return { partnerCode: row && row.kind === 'PARTNER' ? row.code : '',
    campaignCode: row && row.kind !== 'PARTNER' ? row.code : '' };
}

module.exports = { listTracking, createTracking, updateTracking, linkFor, resolveTracking };
