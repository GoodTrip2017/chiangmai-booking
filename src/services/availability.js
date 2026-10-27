const { userError } = require('../util/errors');
/**
 * 空位查詢與容量規則（後端唯一權威）：
 * 每個時段所有組別合計最多 CONFIG.MAX_PAX 人，第一組也適用。
 */
const { pool } = require('../db');
const { CONFIG, SLOTS, STATUS } = require('../config');
const dt = require('../util/datetime');
const rulesService = require('./rules');

/** 讀取某日所有已確認預約。容量須包含與目標時段重疊的舊預約。 */
async function confirmedIn(db, dateStr, slot, excludeId) {
  const params = [dateStr];
  let sql = `SELECT * FROM bookings WHERE status = ANY($2::text[]) AND date = $1`;
  params.push([STATUS.PENDING, STATUS.CONFIRMED, STATUS.CHECKED_IN, STATUS.COMPLETED]);
  if (excludeId) {
    params.push(excludeId);
    sql += ' AND id <> $3';
  }
  sql += ' ORDER BY created_at';
  const { rows } = await db.query(sql, params);
  const target = dt.getSlotDef(slot);
  return rows.filter(b => {
    const other = dt.getSlotDef(b.slot);
    return other && other.start < target.end && target.start < other.end;
  });
}

/** 某時段目前狀態 */
async function slotState(db, dateStr, slot, excludeId) {
  const rules = await rulesService.dayRules(db, dateStr);
  const activeSlot = rules.slots.find(item => item.slot === slot);
  const list = await confirmedIn(db, dateStr, slot, excludeId);
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
    const pax = active.reduce((sum, b) => sum + b.pax, 0);
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

/** 容量判定。excludeId：修改既有預約時排除自己，避免自我衝突。 */
async function capacityCheck(db, dateStr, slot, pax, excludeId, options = {}) {
  const rules = await rulesService.dayRules(db, dateStr);
  const bookable = rulesService.isBookableTime(rules, dateStr, slot, options);
  if (!bookable.ok && !(options.allowLegacySlot === slot && !rules.closed)) return { ok: false, reason: bookable.reason, state: null };
  const state = await slotState(db, dateStr, slot, excludeId);
  if (Number.isInteger(pax) && pax >= 1 && state.totalPax + pax <= state.maxPax) return { ok: true, state };
  return {
    ok: false,
    state,
    reason: `該時段已有 ${state.groups} 組預約、共 ${state.totalPax} 人。` +
      `每個時段接待上限 ${state.maxPax} 人，目前只剩 ` +
      `${state.remaining} 個位子，無法容納 ${pax} 人。`,
  };
}

/** 前台：取某一天六個時段的即時狀態 */
async function getAvailability(dateStr) {
  if (!dt.isValidDateStr(dateStr)) throw userError('日期格式不正確。');
  const rules = await rulesService.dayRules(pool, dateStr);

  const result = {
    date: dateStr,
    dateLabel: dt.formatDateZh(dateStr),
    closed: rules.closed,
    maxPax: rules.settings.max_pax,
    slots: [],
  };
  if (result.closed) {
    result.message = rules.reason || '此日期公休 / Closed on this date.';
    return result;
  }

  for (const def of rules.slots) {
    const st = await slotState(pool, dateStr, def.slot);
    const past = dt.isSlotPast(dateStr, def.slot);
    let status, statusText, maxPax;

    if (def.blocked || def.maxPax === 0) {
      status = 'CLOSED'; statusText = def.reason || '暫停預約 / Unavailable'; maxPax = 0;
    } else if (past || !rulesService.isBookableTime(rules, dateStr, def.slot).ok) {
      status = 'PAST';
      statusText = '已過時間';
      maxPax = 0;
    } else if (st.groups === 0) {
      status = 'OPEN';
      statusText = '可預約';
      maxPax = st.remaining;
    } else if (st.remaining > 0) {
      status = 'PARTIAL';
      statusText = `剩餘 ${st.remaining} 位`;
      maxPax = st.remaining;
    } else {
      status = 'FULL';
      statusText = '已滿';
      maxPax = 0;
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

module.exports = { confirmedIn, slotState, capacityCheck, getAvailability };
