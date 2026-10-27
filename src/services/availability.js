const { userError } = require('../util/errors');
/**
 * 空位查詢與容量規則（後端唯一權威）：
 * 每個時段所有組別合計最多設定容量（硬上限 CONFIG.MAX_PAX）人，第一組也適用。
 * 營業規則與當日預約各只讀一次，之後在記憶體內逐時段計算，避免每個時段重查資料庫。
 */
const { pool } = require('../db');
const { STATUS } = require('../config');
const dt = require('../util/datetime');
const rulesService = require('./rules');

const ACTIVE_STATUSES = [STATUS.PENDING, STATUS.CONFIRMED, STATUS.CHECKED_IN, STATUS.COMPLETED];

/** 讀取某日所有佔用容量的預約（不分時段）。excludeId：修改既有預約時排除自己。 */
async function activeBookings(db, dateStr, excludeId) {
  const params = [dateStr, ACTIVE_STATUSES];
  let sql = 'SELECT *, GREATEST(pax,COALESCE(actual_pax,pax)) AS capacity_pax FROM bookings WHERE status = ANY($2::text[]) AND date = $1';
  if (excludeId) {
    params.push(excludeId);
    sql += ' AND id <> $3';
  }
  sql += ' ORDER BY created_at';
  const { rows } = await db.query(sql, params);
  return rows;
}

/** 與目標時段重疊的預約。容量須包含與目標時段重疊的舊預約。 */
function overlapping(rows, slot) {
  const target = dt.getSlotDef(slot);
  return rows.filter(b => {
    const other = dt.getSlotDef(b.slot);
    return other && other.start < target.end && target.start < other.end;
  });
}

async function confirmedIn(db, dateStr, slot, excludeId) {
  return overlapping(await activeBookings(db, dateStr, excludeId), slot);
}

/** 同一天的規則與預約可由呼叫端預先讀好再傳入，避免重複查詢。 */
async function dayContext(db, dateStr, excludeId, context = {}) {
  return {
    rules: context.rules || await rulesService.dayRules(db, dateStr),
    rows: context.rows || await activeBookings(db, dateStr, excludeId),
  };
}

function slotStateFrom(rules, rows, slot) {
  const activeSlot = rules.slots.find(item => item.slot === slot);
  const list = overlapping(rows, slot);
  const target = dt.getSlotDef(slot);
  // 舊時段可能前後接到兩組新時段；計算任一時刻的最大同時人數，
  // 不把互不相遇的兩組錯加成一組。
  const points = [target.start, ...list.map(b => dt.getSlotDef(b.slot).start)
    .filter(start => start > target.start && start < target.end)];
  let totalPax = 0, groups = 0;
  for (const point of points) {
    const active = list.filter(b => {
      const def = dt.getSlotDef(b.slot);
      return def.start <= point && point < def.end;
    });
    const pax = active.reduce((sum, b) => sum + (b.capacity_pax ?? b.pax), 0);
    if (pax > totalPax) { totalPax = pax; groups = active.length; }
  }
  const maxPax = activeSlot?.maxPax ?? rules.settings.max_pax;
  const remaining = Math.max(0, maxPax - totalPax);
  return {
    slot,
    groups,
    totalPax,
    remaining,
    maxPax, blocked: rules.closed || activeSlot?.blocked || !activeSlot,
    overCapacity: totalPax > maxPax,
    bookings: list.filter(b => b.slot === slot),
  };
}

/** 某時段目前狀態 */
async function slotState(db, dateStr, slot, excludeId, context) {
  const { rules, rows } = await dayContext(db, dateStr, excludeId, context);
  return slotStateFrom(rules, rows, slot);
}

function capacityCheckFrom(rules, rows, dateStr, slot, pax, options = {}) {
  const bookable = rulesService.isBookableTime(rules, dateStr, slot, options);
  // 既有預約沿用原時段（含舊時段、已封鎖或已停開的日期）時不受可預約性限制，仍依下方容量判定。
  if (!bookable.ok && options.allowLegacySlot !== slot) return { ok: false, reason: bookable.reason, state: null };
  const state = slotStateFrom(rules, rows, slot);
  const target = dt.getSlotDef(slot);
  const list = overlapping(rows, slot);
  const points = [target.start,
    ...list.map(row => dt.getSlotDef(row.slot).start),
    ...rules.slots.map(row => row.start)].filter(point => point >= target.start && point < target.end);
  let limiting = null;
  let minAvailable = state.maxPax;
  for (const point of new Set(points)) {
    const inUse = list.filter(row => {
      const def = dt.getSlotDef(row.slot);
      return def.start <= point && point < def.end;
    }).reduce((sum, row) => sum + (row.capacity_pax ?? row.pax), 0);
    const caps = [state.maxPax, ...rules.slots.filter(row => row.start <= point && point < row.end)
      .map(row => row.blocked ? 0 : row.maxPax)];
    const cap = Math.min(...caps);
    minAvailable = Math.min(minAvailable, cap - inUse);
    if (inUse + pax > cap) { limiting = { inUse, cap }; break; }
  }
  state.effectiveRemaining = Math.max(0, minAvailable);
  if (Number.isInteger(pax) && pax >= 1 && !limiting) return { ok: true, state };
  const used = limiting?.inUse ?? state.totalPax;
  const cap = limiting?.cap ?? state.maxPax;
  return {
    ok: false,
    state,
    reason: `重疊時間已有 ${used} 人；同時接待上限 ${cap} 人，` +
      `目前只剩 ${Math.max(0, cap - used)} 位，無法容納 ${pax} 人。 / ` +
      `Only ${Math.max(0, cap - used)} places remain for this overlapping visit time.`,
  };
}

/** 容量判定。excludeId：修改既有預約時排除自己，避免自我衝突。context：已讀好的當日規則與預約。 */
async function capacityCheck(db, dateStr, slot, pax, excludeId, options = {}, context) {
  const { rules, rows } = await dayContext(db, dateStr, excludeId, context);
  return capacityCheckFrom(rules, rows, dateStr, slot, pax, options);
}

/** 前台：取某一天各時段的即時狀態。規則與預約各讀一次。statusText 一律雙語。 */
async function getAvailability(dateStr, db = pool) {
  if (!dt.isValidDateStr(dateStr)) throw userError('日期格式不正確 / Invalid date.');
  const rules = await rulesService.dayRules(db, dateStr);

  const result = {
    date: dateStr,
    dateLabel: dt.formatDateZh(dateStr),
    closed: rules.closed,
    maxPax: rules.settings.max_pax,
    slots: [],
  };
  if (result.closed) {
    result.message = (rules.reason ? `${rules.reason} · ` : '') + '此日期公休 / Closed on this date.';
    return result;
  }

  const rows = await activeBookings(db, dateStr);
  for (const def of rules.slots) {
    const st = slotStateFrom(rules, rows, def.slot);
    const checked = capacityCheckFrom(rules, rows, dateStr, def.slot, 1);
    const remaining = checked.state?.effectiveRemaining ?? 0;
    const bookable = rulesService.isBookableTime(rules, dateStr, def.slot);
    let status, statusText, maxPax;

    if (def.blocked || def.maxPax === 0) {
      status = 'CLOSED'; statusText = (def.reason ? `${def.reason} · ` : '') + '暫停預約 / Unavailable'; maxPax = 0;
    } else if (dt.isSlotPast(dateStr, def.slot)) {
      status = 'PAST'; statusText = '已過時間 / Past time'; maxPax = 0;
    } else if (!bookable.ok && bookable.code === 'CUTOFF') {
      status = 'PAST'; statusText = '已過預約截止時間 / Booking cutoff passed'; maxPax = 0;
    } else if (!bookable.ok) {
      status = 'UNAVAILABLE'; statusText = '尚未開放預約 / Not yet open for booking'; maxPax = 0;
    } else if (st.groups === 0 && remaining > 0) {
      status = 'OPEN'; statusText = '可預約 / Available'; maxPax = remaining;
    } else if (remaining > 0) {
      status = 'PARTIAL'; statusText = `剩餘 ${remaining} 位 / ${remaining} places left`; maxPax = remaining;
    } else {
      status = 'FULL'; statusText = '已滿 / Full'; maxPax = 0;
    }

    result.slots.push({
      slot: def.slot,
      label: dt.slotLabelZh(def.slot),
      status,
      statusText,
      maxPax,
      selectable: status === 'OPEN' || status === 'PARTIAL',
    });
  }
  return result;
}

module.exports = { activeBookings, confirmedIn, slotState, slotStateFrom, capacityCheck, capacityCheckFrom, getAvailability };
