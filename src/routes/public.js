/** 前台 API */
const express = require('express');
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

router.post('/bookings', async (req, res, next) => {
  try {
    res.json(await submitBooking(req.body));
  } catch (err) { next(err); }
});

module.exports = router;
