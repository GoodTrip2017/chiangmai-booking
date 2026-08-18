/** 前台 API */
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { getAvailability } = require('../services/availability');
const { submitBooking } = require('../services/booking');
const { CONFIG } = require('../config');
const dt = require('../util/datetime');

const router = express.Router();

router.get('/config', (req, res) => {
  res.json({
    today: dt.todayStr(),
    lineUrl: CONFIG.LINE_URL,
    businessHours: CONFIG.BUSINESS_HOURS,
    graceMinutes: CONFIG.GRACE_MINUTES,
  });
});

router.get('/availability', async (req, res, next) => {
  try {
    res.json(await getAvailability(String(req.query.date || '')));
  } catch (err) { next(err); }
});

/** 防灌單：同一 IP 每分鐘最多 3 筆、每天最多 20 筆預約 */
const bookingLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '操作太頻繁，請稍候一分鐘再試。' },
});
const bookingDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '今日預約次數已達上限，請改用 LINE 與我們聯絡。' },
});

router.post('/bookings', bookingDailyLimiter, bookingLimiter, async (req, res, next) => {
  try {
    res.json(await submitBooking(req.body));
  } catch (err) { next(err); }
});

module.exports = router;
