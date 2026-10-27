/** 前台 API */
const express = require('express');
const { limitBooking } = require('../services/rateLimits');
const { getAvailability } = require('../services/availability');
const { submitBooking } = require('../services/booking');
const { CONFIG } = require('../config');
const dt = require('../util/datetime');
const discovery = require('../services/discovery');
const rules = require('../services/rules');

const router = express.Router();

router.get('/discovery-sources', async (req, res, next) => {
  try { res.json({ sources: await discovery.listSources() }); }
  catch (err) { next(err); }
});

router.get('/config', async (req, res, next) => {
  try {
  const settings = await rules.readSettings();
  res.json({
    today: dt.todayStr(),
    lineUrl: CONFIG.LINE_URL,
    businessHours: `${settings.open_time}–${settings.close_time}`,
    startTime: settings.open_time,
    serviceMinutes: settings.service_minutes,
    closedWeekdays: settings.closed_weekdays,
    graceMinutes: CONFIG.GRACE_MINUTES,
    maxPax: settings.max_pax,
  });
  } catch (err) { next(err); }
});

router.get('/availability', async (req, res, next) => {
  try {
    res.json(await getAvailability(req.query.date));
  } catch (err) { next(err); }
});

/** 同一 IP 每分鐘 3 次／每天 20 次；跨實例與重啟共用資料庫計數。 */
router.post('/bookings', limitBooking, async (req, res, next) => {
  try {
    res.json(await submitBooking(req.body));
  } catch (err) { next(err); }
});

module.exports = router;
