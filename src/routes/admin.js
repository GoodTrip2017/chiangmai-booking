/** 後台 API。每個請求都要帶 X-Admin-Token（或 ?token=）。 */
const express = require('express');
const { getWeekData } = require('../services/admin');
const booking = require('../services/booking');

const router = express.Router();

function isAdminToken(token) {
  const expected = process.env.ADMIN_TOKEN || '';
  return !!expected && token === expected;
}

router.use((req, res, next) => {
  const token = req.get('X-Admin-Token') || String(req.query.token || '');
  if (!isAdminToken(token)) {
    return res.status(401).json({ error: '無權限：後台憑證不正確，請重新開啟後台連結。' });
  }
  next();
});

router.get('/week', async (req, res, next) => {
  try {
    const monday = String(req.query.monday || '') || require('../util/datetime').todayStr();
    res.json(await getWeekData(monday));
  } catch (err) { next(err); }
});

router.post('/bookings', async (req, res, next) => {
  try {
    res.json(await booking.createManualBooking(req.body));
  } catch (err) { next(err); }
});

router.put('/bookings/:id', async (req, res, next) => {
  try {
    res.json(await booking.updateBooking({ ...req.body, id: req.params.id }));
  } catch (err) { next(err); }
});

router.post('/bookings/:id/cancel', async (req, res, next) => {
  try {
    res.json(await booking.cancelBooking(req.params.id));
  } catch (err) { next(err); }
});

router.post('/bookings/:id/resend-mail', async (req, res, next) => {
  try {
    res.json(await booking.resendConfirmation(req.params.id));
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.isAdminToken = isAdminToken;
