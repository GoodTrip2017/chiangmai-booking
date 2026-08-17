/**
 * 清邁時間（GMT+7，無夏令時間）的日期時間工具。
 * 內部一律用「把 UTC 時間加 7 小時後取 UTC 欄位」的方式計算，避免依賴伺服器時區。
 */
const { CONFIG, SLOTS } = require('../config');

const OFFSET_MS = CONFIG.TZ_OFFSET_MINUTES * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAY_ZH = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 現在的清邁牆上時間（以「偏移後的 Date、讀 UTC 欄位」表示） */
function nowBkk() {
  return new Date(Date.now() + OFFSET_MS);
}

function todayStr() {
  const d = nowBkk();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function isValidDateStr(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return false;
  const [y, m, day] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, day));
  return d.getUTCFullYear() === y && d.getUTCMonth() === m - 1 && d.getUTCDate() === day;
}

/** 'yyyy-MM-dd' + 'HH:mm'（清邁時間）→ 真正的 UTC 時間戳（ms） */
function toUtcMs(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - OFFSET_MS;
}

/** ISO 星期：1 = 週一 ... 7 = 週日 */
function isoWeekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=週日
  return wd === 0 ? 7 : wd;
}

function weekdayZh(dateStr) {
  return WEEKDAY_ZH[isoWeekday(dateStr) - 1];
}

function isClosedDay(dateStr) {
  return CONFIG.CLOSED_WEEKDAYS.includes(isoWeekday(dateStr));
}

function getSlotDef(slot) {
  return SLOTS.find((s) => s.slot === slot) || null;
}

function addDaysStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const nd = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return `${nd.getUTCFullYear()}-${pad2(nd.getUTCMonth() + 1)}-${pad2(nd.getUTCDate())}`;
}

/** 該日期所屬那一週的星期一 */
function mondayOf(dateStr) {
  return addDaysStr(dateStr, -(isoWeekday(dateStr) - 1));
}

/** 該時段是否已經開始（今天的過去時段不可預約） */
function isSlotPast(dateStr, slot) {
  const def = getSlotDef(slot);
  if (!def) return true;
  return toUtcMs(dateStr, def.start) <= Date.now();
}

/** 2026-02-18 → 2026年2月18日（週三） */
function formatDateZh(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${y}年${m}月${d}日（${weekdayZh(dateStr)}）`;
}

/** '16:30' → '下午 4:30' */
function formatTimeZh(timeStr) {
  const [hStr, m] = String(timeStr).split(':');
  const h = Number(hStr);
  const isPm = h >= 12;
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${isPm ? '下午' : '上午'} ${h12}:${m}`;
}

/** '16:30-18:30' → '下午 4:30 – 下午 6:30' */
function slotLabelZh(slot) {
  const def = getSlotDef(slot);
  return `${formatTimeZh(def.start)} – ${formatTimeZh(def.end)}`;
}

/** 時段開始 + GRACE_MINUTES，回傳 '下午 8:40' */
function graceDeadlineZh(dateStr, slot) {
  const def = getSlotDef(slot);
  const deadline = new Date(toUtcMs(dateStr, def.start) + CONFIG.GRACE_MINUTES * 60 * 1000 + OFFSET_MS);
  return formatTimeZh(`${pad2(deadline.getUTCHours())}:${pad2(deadline.getUTCMinutes())}`);
}

/** Date（UTC 時間戳）→ 清邁時間 'MM/dd HH:mm'，後台顯示用 */
function formatShortBkk(date) {
  const d = new Date(date.getTime() + OFFSET_MS);
  return `${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

module.exports = {
  todayStr, isValidDateStr, isoWeekday, weekdayZh, isClosedDay, getSlotDef,
  addDaysStr, mondayOf, isSlotPast, formatDateZh, formatTimeZh, slotLabelZh,
  graceDeadlineZh, formatShortBkk,
};
