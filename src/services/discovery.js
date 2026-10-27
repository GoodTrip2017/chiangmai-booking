const crypto = require('node:crypto');
const { pool } = require('../db');
const { userError } = require('../util/errors');

const LEGACY_IDS = Object.freeze({
  Instagram: 'instagram',
  '親友介紹': 'friends-family',
  Threads: 'legacy-threads',
  GoodTrip官網: 'legacy-goodtrip-web',
  GoodTrip門市: 'legacy-goodtrip-store',
  網路搜尋: 'legacy-online-search',
});

function cleanLabel(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw userError(`${name}格式不正確 / Invalid ${name === '中文名稱' ? 'Chinese' : 'English'} label.`);
  }
  return value.trim();
}

async function listSources(includeInactive = false) {
  const { rows } = await pool.query(
    `SELECT id, label_zh AS "labelZh", label_en AS "labelEn", sort_order AS "sortOrder", active
     FROM discovery_sources ${includeInactive ? '' : 'WHERE active = true'} ORDER BY sort_order, id`
  );
  return rows;
}

async function resolveSource(client, data, { optional = false, currentId = null } = {}) {
  const id = data.discoverySourceId || LEGACY_IDS[data.referral] || '';
  if (!id) {
    if (optional) return { id: null, label: data.referral || '' };
    throw userError('請選擇得知管道 / Please select how you heard about us.');
  }
  const { rows } = await client.query('SELECT id, label_zh, active FROM discovery_sources WHERE id = $1', [id]);
  const source = rows[0];
  if (!source || (data.discoverySourceId && !source.active && source.id !== currentId)) {
    throw userError('得知管道選項已停用，請重新選擇 / This discovery source is no longer available.');
  }
  if (data.discoveryDetail && !['other', 'hotel-accommodation', 'partner-event'].includes(id)) {
    throw userError('此得知管道不需要補充名稱 / This source does not accept extra details.');
  }
  return { id: source.id, label: source.label_zh };
}

async function createSource(input) {
  const labelZh = cleanLabel(input?.labelZh, '中文名稱');
  const labelEn = cleanLabel(input?.labelEn, '英文名稱');
  const sortOrder = Number(input?.sortOrder);
  if (!Number.isSafeInteger(sortOrder) || sortOrder < -10000 || sortOrder > 10000) throw userError('排序值不正確 / Invalid sort order.');
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO discovery_sources (id, label_zh, label_en, sort_order) VALUES ($1,$2,$3,$4)',
    [id, labelZh, labelEn, sortOrder]);
  return { id, labelZh, labelEn, sortOrder, active: true };
}

async function updateSource(id, input) {
  if (typeof id !== 'string' || id.length > 80 || !/^[a-z0-9-]+$/.test(id)) throw userError('選項 ID 格式不正確 / Invalid source ID.');
  const labelZh = cleanLabel(input?.labelZh, '中文名稱');
  const labelEn = cleanLabel(input?.labelEn, '英文名稱');
  const sortOrder = Number(input?.sortOrder);
  if (!Number.isSafeInteger(sortOrder) || sortOrder < -10000 || sortOrder > 10000 || typeof input?.active !== 'boolean') {
    throw userError('排序或啟用狀態不正確 / Invalid order or active state.');
  }
  const { rows } = await pool.query(
    `UPDATE discovery_sources SET label_zh=$1, label_en=$2, sort_order=$3, active=$4
     WHERE id=$5 RETURNING id, label_zh AS "labelZh", label_en AS "labelEn", sort_order AS "sortOrder", active`,
    [labelZh, labelEn, sortOrder, input.active, id]
  );
  if (!rows[0]) throw userError('找不到得知管道 / Source not found.', 404);
  return rows[0];
}

module.exports = { LEGACY_IDS, listSources, resolveSource, createSource, updateSource };
