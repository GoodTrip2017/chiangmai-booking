/**
 * 全域設定與時段定義。營業規則只改這裡，前後台會一起跟著變。
 */
require('dotenv').config();

const CONFIG = {
  TZ_OFFSET_MINUTES: 7 * 60,          // Asia/Bangkok GMT+7（無夏令時間）
  MAX_PAX: 12,                        // 每個時段所有預約合計的接待上限
  CLOSED_WEEKDAYS: [2],               // 公休日：2 = 週二（ISO 週一=1 ... 週日=7）
  GRACE_MINUTES: 10,                  // 座位保留分鐘數
  EVENT_NAME: '頂級飛行體驗 (GoodTrip x Herb Uncle 清邁尼曼店)',
  VENUE_NAME: 'GoodTrip x Herb Uncle 清邁尼曼店',
  VENUE_ADDRESS: '162 11, Tambon Chang Phueak, Mueang Chiang Mai District, Chiang Mai 50300, Thailand',
  MAP_URL: 'https://www.google.com/maps/search/?api=1&query=GoodTrip+x+Herb+Uncle+Cannabis+CNX+Chiang+Mai',
  LINE_URL: 'https://lin.ee/DcpM9f7',
  SENDER_NAME: 'GoodTrip x Herb Uncle 清邁尼曼店',
  BUSINESS_HOURS: '14:00 - 23:00',
};

/** 14:00–23:00 每段 90 分鐘；slot 字串就是資料庫裡的鍵值。 */
const SLOTS = [
  { slot: '14:00-15:30', start: '14:00', end: '15:30' },
  { slot: '15:30-17:00', start: '15:30', end: '17:00' },
  { slot: '17:00-18:30', start: '17:00', end: '18:30' },
  { slot: '18:30-20:00', start: '18:30', end: '20:00' },
  { slot: '20:00-21:30', start: '20:00', end: '21:30' },
  { slot: '21:30-23:00', start: '21:30', end: '23:00' },
];
/** 保留舊預約原時段；新預約不能再選這些時段。 */
const LEGACY_SLOTS = [
  { slot: '14:30-16:30', start: '14:30', end: '16:30' },
  { slot: '16:30-18:30', start: '16:30', end: '18:30' },
  { slot: '18:30-20:30', start: '18:30', end: '20:30' },
  { slot: '20:30-22:30', start: '20:30', end: '22:30' },
];

const REFERRAL_OPTIONS = ['Instagram', 'Threads', 'GoodTrip官網', 'GoodTrip門市', '親友介紹', '網路搜尋'];

const SOURCES = ['WEB', 'WALK_IN', 'LINE', 'PHONE'];

const STATUS = { CONFIRMED: 'CONFIRMED', CANCELLED: 'CANCELLED' };

module.exports = { CONFIG, SLOTS, LEGACY_SLOTS, REFERRAL_OPTIONS, SOURCES, STATUS };
