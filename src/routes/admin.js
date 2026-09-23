/** 後台 API：資料庫工作階段 + 同源 CSRF 驗證。 */
const express = require('express');
const { getWeekData } = require('../services/admin');
const booking = require('../services/booking');
const auth = require('../services/auth');
const { pool } = require('../db');

const router = express.Router();

router.use(auth.requireAdmin, auth.requireCsrf);
router.get('/session', (req, res) => res.json({ csrfToken: req.adminSession.csrf_token }));
router.get('/line/groups', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT group_id, seen_at FROM line_group_candidates ORDER BY seen_at DESC LIMIT 10');
    res.json({ webhookReady: !!process.env.LINE_CHANNEL_SECRET,
      pushReady: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
      selectedGroupId: process.env.LINE_GROUP_ID || '', groups: rows });
  } catch (err) { next(err); }
});
router.post('/logout', auth.logout);

router.get('/week', async (req, res, next) => {
  try {
    const monday = req.query.monday === undefined || req.query.monday === '' ? require('../util/datetime').todayStr() : req.query.monday;
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
