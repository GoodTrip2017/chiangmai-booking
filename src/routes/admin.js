/** 後台 API：資料庫工作階段 + 同源 CSRF 驗證。 */
const express = require('express');
const { getWeekData } = require('../services/admin');
const booking = require('../services/booking');
const auth = require('../services/auth');
const { pool } = require('../db');
const discovery = require('../services/discovery');
const lifecycle = require('../services/lifecycle');
const reporting = require('../services/reporting');

const router = express.Router();

router.use(auth.requireAdmin, auth.requireCsrf);
router.get('/session', (req, res) => res.json({ csrfToken: req.adminSession.csrf_token, role: req.adminSession.role,
  username: req.adminSession.username || '', today: require('../util/datetime').todayStr() }));
router.get('/line/groups', auth.requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT group_id, seen_at FROM line_group_candidates ORDER BY seen_at DESC LIMIT 10');
    res.json({ webhookReady: !!process.env.LINE_CHANNEL_SECRET,
      pushReady: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
      selectedGroupId: process.env.LINE_GROUP_ID || '', groups: rows });
  } catch (err) { next(err); }
});
router.post('/logout', auth.logout);

router.get('/discovery-sources', async (req, res, next) => {
  try { res.json({ sources: await discovery.listSources(true) }); }
  catch (err) { next(err); }
});
router.post('/discovery-sources', auth.requireRole('ADMIN'), async (req, res, next) => {
  try { res.status(201).json(await discovery.createSource(req.body)); }
  catch (err) { next(err); }
});
router.put('/discovery-sources/:id', auth.requireRole('ADMIN'), async (req, res, next) => {
  try { res.json(await discovery.updateSource(req.params.id, req.body)); }
  catch (err) { next(err); }
});

router.get('/week', auth.requireRole('ADMIN','STAFF'), async (req, res, next) => {
  try {
    const monday = req.query.monday === undefined || req.query.monday === '' ? require('../util/datetime').todayStr() : req.query.monday;
    res.json(await getWeekData(monday));
  } catch (err) { next(err); }
});

router.get('/bookings', async (req, res, next) => {
  try { res.json(await reporting.listBookings(req.query, req.adminSession.role)); } catch (err) { next(err); }
});
router.get('/bookings/:id', auth.requireRole('ADMIN','STAFF'), async (req, res, next) => {
  try { res.json(await reporting.bookingDetail(req.params.id)); } catch (err) { next(err); }
});
router.get('/analytics', async (req, res, next) => {
  try { res.json(await reporting.analytics(req.query)); } catch (err) { next(err); }
});

router.post('/bookings', auth.requireRole('ADMIN','STAFF'), async (req, res, next) => {
  try {
    res.json(await booking.createManualBooking(req.body));
  } catch (err) { next(err); }
});

router.put('/bookings/:id', auth.requireRole('ADMIN','STAFF'), async (req, res, next) => {
  try {
    if (!Number.isSafeInteger(req.body?.revision)) throw require('../util/errors').userError('請重新整理預約資料後再操作 / Refresh the booking before editing.', 409);
    res.json(await booking.updateBooking({ ...req.body, id: req.params.id }));
  } catch (err) { next(err); }
});

router.post('/bookings/:id/cancel', auth.requireRole('ADMIN','STAFF'), async (req, res, next) => {
  try {
    if (!Number.isSafeInteger(req.body?.revision)) throw require('../util/errors').userError('請重新整理預約資料後再操作 / Refresh the booking before editing.', 409);
    if (typeof req.body.reason !== 'string' || !req.body.reason.trim()) throw require('../util/errors').userError('請填寫取消原因 / A cancellation reason is required.');
    res.json(await booking.cancelBooking(req.params.id, req.body));
  } catch (err) { next(err); }
});

router.post('/bookings/:id/status', auth.requireRole('ADMIN','STAFF'), async (req, res, next) => {
  try { res.json(await lifecycle.changeStatus(req.params.id, req.body)); }
  catch (err) { next(err); }
});

router.post('/bookings/:id/resend-mail', auth.requireRole('ADMIN','STAFF'), async (req, res, next) => {
  try {
    res.json(await booking.resendConfirmation(req.params.id));
  } catch (err) { next(err); }
});

router.get('/accounts', auth.requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id,username,display_name,role,active,created_at FROM staff_accounts ORDER BY created_at DESC');
    res.json({ accounts: rows });
  } catch (err) { next(err); }
});
router.post('/accounts', auth.requireRole('ADMIN'), async (req, res, next) => {
  try { res.status(201).json(await auth.createAccount(req.body)); } catch (err) { next(err); }
});
router.patch('/accounts/:id', auth.requireRole('ADMIN'), async (req, res, next) => {
  try { res.json(await auth.setAccountActive(req.params.id, req.body?.active)); } catch (err) { next(err); }
});

module.exports = router;
