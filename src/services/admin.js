/** 後台週行事曆資料 */
const { pool } = require('../db');
const { CONFIG, SLOTS } = require('../config');
const dt = require('../util/datetime');
const { slotState } = require('./availability');

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
    mailFailed: b.note.includes('MAIL_FAILED'),
    createdAt: dt.formatShortBkk(new Date(b.created_at)),
  };
}

/** 一週的預約總覽（週一 ~ 週日） */
async function getWeekData(mondayStr) {
  if (!dt.isValidDateStr(mondayStr)) throw new Error('日期格式不正確。');
  const monday = dt.mondayOf(mondayStr);
  const today = dt.todayStr();

  const days = [];
  for (let d = 0; d < 7; d++) {
    const dateStr = dt.addDaysStr(monday, d);
    const [, m, dayNum] = dateStr.split('-').map(Number);
    const day = {
      date: dateStr,
      dayLabel: `${m}/${dayNum}`,
      weekday: dt.weekdayZh(dateStr),
      closed: dt.isClosedDay(dateStr),
      isToday: dateStr === today,
      slots: [],
    };
    for (const def of SLOTS) {
      const st = await slotState(pool, dateStr, def.slot);
      day.slots.push({
        slot: def.slot,
        groups: st.groups,
        totalPax: st.totalPax,
        remaining: st.remaining,
        isWholeVenue: st.isWholeVenue,
        full: st.groups > 0 && st.remaining <= 0,
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
    maxPax: CONFIG.MAX_PAX_MULTI,
    slotDefs: SLOTS.map((s) => ({ slot: s.slot, label: dt.slotLabelZh(s.slot) })),
    days,
  };
}

module.exports = { getWeekData };
