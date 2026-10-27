const { userError } = require('../util/errors');
/** 後台週行事曆資料 */
const { pool } = require('../db');
const { STATUS } = require('../config');
const dt = require('../util/datetime');
const { slotState, activeBookings } = require('./availability');
const { dayRules, readSettings } = require('./rules');

function publicBooking(b) {
  return {
    id: b.id,
    source: b.source,
    name: b.name,
    pax: b.pax,
    date: b.date,
    slot: b.slot,
    firstTime: b.first_time,
    line: b.line,
    email: b.email,
    referral: b.referral,
    note: b.note,
    mailStatus: b.mail_status,
    status: b.status,
    revision: b.revision,
    actualPax: b.actual_pax,
    discoverySourceId: b.discovery_source_id,
    discoveryDetail: b.discovery_detail,
    internalNote: b.internal_note,
    mailFailed: ['FAILED', 'NOT_CONFIGURED'].includes(b.mail_status) || b.note.includes('MAIL_FAILED'),
    createdAt: dt.formatShortBkk(new Date(b.created_at)),
  };
}

/** 一週的預約總覽（週一 ~ 週日） */
async function getWeekData(mondayStr) {
  if (!dt.isValidDateStr(mondayStr)) throw userError('日期格式不正確 / Invalid date.');
  const monday = dt.mondayOf(mondayStr);
  const today = dt.todayStr();
  const sunday = dt.addDaysStr(monday, 6);
  const settings = await readSettings(pool);
  const { rows: usedRows } = await pool.query(
    'SELECT DISTINCT slot FROM bookings WHERE status = ANY($1::text[]) AND date BETWEEN $2 AND $3',
    [[STATUS.PENDING, STATUS.CONFIRMED, STATUS.CHECKED_IN, STATUS.COMPLETED], monday, sunday]
  );
  const dayRuleList = [];
  for (let d = 0; d < 7; d++) dayRuleList.push(await dayRules(pool, dt.addDaysStr(monday, d)));
  const currentSlots = new Map(dayRuleList.flatMap(rule => rule.slots).map(slot => [slot.slot, slot]));
  const definitions = new Map(currentSlots);
  for (const row of usedRows) if (!definitions.has(row.slot)) {
    const legacy = dt.getSlotDef(row.slot);
    if (legacy) definitions.set(row.slot, legacy);
  }
  const defs = [...definitions.values()].map(def => ({ ...def, legacy: !currentSlots.has(def.slot) })).sort((a,b) => a.slot.localeCompare(b.slot));

  const days = [];
  for (let d = 0; d < 7; d++) {
    const dateStr = dt.addDaysStr(monday, d);
    const [, m, dayNum] = dateStr.split('-').map(Number);
    const day = {
      date: dateStr,
      dayLabel: `${m}/${dayNum}`,
      weekday: dt.weekdayZh(dateStr),
      closed: dayRuleList[d].closed,
      isToday: dateStr === today,
      slots: [],
    };
    // 營業規則與當日預約各讀一次，再逐時段計算，避免每格都重查資料庫。
    const context = { rules: dayRuleList[d], rows: await activeBookings(pool, dateStr) };
    for (const def of defs) {
      const st = await slotState(pool, dateStr, def.slot, undefined, context);
      day.slots.push({
        slot: def.slot,
        groups: st.groups,
        totalPax: st.totalPax,
        remaining: st.remaining,
        overCapacity: st.overCapacity,
        full: st.groups > 0 && st.remaining <= 0,
        bookable: !dayRuleList[d].closed && dayRuleList[d].slots.some(row => row.slot === def.slot && !row.blocked && row.maxPax > 0),
        bookings: st.bookings.map(publicBooking),
      });
    }
    days.push(day);
  }

  return {
    monday,
    prevMonday: dt.addDaysStr(monday, -7),
    nextMonday: dt.addDaysStr(monday, 7),
    thisMonday: dt.mondayOf(today),
    rangeLabel: `${dt.formatDateZh(monday)} ~ ${dt.formatDateZh(dt.addDaysStr(monday, 6))}`,
    maxPax: settings.max_pax,
    slotDefs: defs.map((s) => ({ slot: s.slot, label: dt.slotLabelZh(s.slot), legacy: s.legacy })),
    days,
  };
}

module.exports = { getWeekData };
