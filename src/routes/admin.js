/** 後台 API：資料庫工作階段 + 同源 CSRF 驗證。 */
const express = require('express');
const { getWeekData } = require('../services/admin');
const booking = require('../services/booking');
const auth = require('../services/auth');
const { pool } = require('../db');
const discovery = require('../services/discovery');
const lifecycle = require('../services/lifecycle');
const reporting = require('../services/reporting');
const rules = require('../services/rules');
const tracking = require('../services/tracking');
const QRCode = require('qrcode');
const customers = require('../services/customers');
const notificationPolicy = require('../services/notificationPolicy');
const audit = require('../services/audit');
const lineNotify = require('../services/lineNotify');

const router = express.Router();
const actorFor = req => ({ type: req.adminSession.role, id: req.adminSession.account_id || 'environment-admin' });

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
router.get('/notification-settings', auth.requireRole('ADMIN'), async (req, res, next) => {
  try { res.json({ items: await notificationPolicy.listPolicies(), variables: notificationPolicy.VARIABLES }); }
  catch (err) { next(err); }
});
router.put('/notification-settings/:eventType', auth.requireRole('ADMIN'), async (req, res, next) => {
  try {
    const result = await notificationPolicy.updatePolicy(req.params.eventType, req.body);
    await audit.record(actorFor(req), 'NOTIFICATION_POLICY_UPDATED', req.params.eventType,
      { enabled: result.enabled, reminderMinutes: result.reminder_minutes });
    res.json(result);
  }
  catch (err) { next(err); }
});
router.post('/notification-settings/:eventType/preview', auth.requireRole('ADMIN'), async (req, res, next) => {
  try {
    if (!notificationPolicy.EVENTS.includes(req.params.eventType)) throw require('../util/errors').userError('通知事件不正確 / Invalid event.');
    const template_zh = notificationPolicy.validateTemplate(req.body?.templateZh);
    const template_en = notificationPolicy.validateTemplate(req.body?.templateEn);
    const sample = { id: 'SAMPLE-BOOKING', name: 'Sample Contact', date: '2026-10-27', slot: '14:00-15:30',
      pax: 2, email: 'sample@example.invalid', line: '', note: '' };
    res.json({ preview: notificationPolicy.preview({ template_zh, template_en }, sample) });
  } catch (err) { next(err); }
});

router.get('/discovery-sources', async (req, res, next) => {
  try { res.json({ sources: await discovery.listSources(true) }); }
  catch (err) { next(err); }
});
router.post('/discovery-sources', auth.requireRole('ADMIN'), async (req, res, next) => {
  try { const result = await discovery.createSource(req.body); await audit.record(actorFor(req), 'DISCOVERY_SOURCE_CREATED', result.id); res.status(201).json(result); }
  catch (err) { next(err); }
});
router.put('/discovery-sources/:id', auth.requireRole('ADMIN'), async (req, res, next) => {
  try { const result = await discovery.updateSource(req.params.id, req.body); await audit.record(actorFor(req), 'DISCOVERY_SOURCE_UPDATED', req.params.id); res.json(result); }
  catch (err) { next(err); }
});

router.get('/tracking-links', auth.requireRole('ADMIN'), async (req, res, next) => {
  try {
    const origin = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
    const items = await tracking.listTracking();
    res.json({ items: items.map(item => ({ ...item, url: tracking.linkFor(item, origin) })) });
  } catch (err) { next(err); }
});
router.post('/tracking-links', auth.requireRole('ADMIN'), async (req, res, next) => {
  try { const result = await tracking.createTracking(req.body); await audit.record(actorFor(req), 'TRACKING_LINK_CREATED', result.code); res.status(201).json(result); } catch (err) { next(err); }
});
router.patch('/tracking-links/:code', auth.requireRole('ADMIN'), async (req, res, next) => {
  try { const result = await tracking.updateTracking(req.params.code, req.body); await audit.record(actorFor(req), 'TRACKING_LINK_UPDATED', req.params.code); res.json(result); } catch (err) { next(err); }
});
router.get('/tracking-links/:code/qr.svg', auth.requireRole('ADMIN'), async (req, res, next) => {
  try {
    const items = await tracking.listTracking();
    const item = items.find(row => row.code === req.params.code);
    if (!item) throw require('../util/errors').userError('找不到追蹤代碼 / Tracking code not found.', 404);
    const origin = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
    const svg = await QRCode.toString(tracking.linkFor(item, origin), { type: 'svg', margin: 4, width: 512, errorCorrectionLevel: 'M' });
    res.set({ 'Content-Type': 'image/svg+xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="booking-${item.code}.svg"`,
      'X-Content-Type-Options': 'nosniff' });
    res.send(svg);
  } catch (err) { next(err); }
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
router.get('/bookings.csv', auth.requireRole('ADMIN'), async (req, res, next) => {
  try {
    const csv = await reporting.exportBookingsCsv(req.query);
    const filter = reporting.filters(req.query);
    await audit.record(actorFor(req), 'BOOKINGS_CSV_EXPORTED', '',
      { from: filter.from, to: filter.to, basis: filter.basis, status: filter.status, discovery: filter.discovery });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="chiangmai-bookings.csv"',
      'Cache-Control': 'no-store' });
    res.send(csv);
  } catch (err) { next(err); }
});
router.get('/bookings/:id', auth.requireRole('ADMIN','STAFF'), async (req, res, next) => {
  try { res.json(await reporting.bookingDetail(req.params.id)); } catch (err) { next(err); }
});
router.get('/assignees', auth.requireRole('ADMIN','STAFF'), async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT id,display_name,role FROM staff_accounts WHERE active=true AND role IN ('ADMIN','STAFF') ORDER BY display_name,id");
    res.json({ items: rows });
  } catch (err) { next(err); }
});
router.get('/customers', auth.requireRole('ADMIN','STAFF'), async (req, res, next) => {
  try { res.json(await customers.listCustomers(req.query)); } catch (err) { next(err); }
});
router.get('/customers/:id', auth.requireRole('ADMIN','STAFF'), async (req, res, next) => {
  try { res.json(await customers.customerDetail(req.params.id)); } catch (err) { next(err); }
});
router.get('/analytics', async (req, res, next) => {
  try { res.json(await reporting.analytics(req.query)); } catch (err) { next(err); }
});
router.get('/overview', auth.requireRole('ADMIN','STAFF'), async (req, res, next) => {
  try { res.json(await reporting.operationalOverview()); } catch (err) { next(err); }
});
router.get('/availability-settings', auth.requireRole('ADMIN'), async (req, res, next) => {
  try { res.json({ settings: await rules.readSettings() }); } catch (err) { next(err); }
});
router.put('/availability-settings', auth.requireRole('ADMIN'), async (req, res, next) => {
  try {
    const result = await rules.updateSettings(req.body);
    if (result.ok) await audit.record(actorFor(req), 'AVAILABILITY_SETTINGS_UPDATED');
    res.status(result.ok ? 200 : 409).json(result);
  } catch (err) { next(err); }
});
router.get('/availability-exceptions', auth.requireRole('ADMIN'), async (req, res, next) => {
  try {
    const [exceptions, overrides] = await Promise.all([
      pool.query('SELECT * FROM availability_exceptions ORDER BY date DESC LIMIT 100'),
      pool.query('SELECT * FROM slot_overrides ORDER BY date DESC,slot LIMIT 200'),
    ]);
    res.json({ exceptions: exceptions.rows, overrides: overrides.rows });
  } catch (err) { next(err); }
});
router.put('/availability-exceptions/:date', auth.requireRole('ADMIN'), async (req, res, next) => {
  try { const result = await rules.upsertException({ ...req.body, date: req.params.date }); if (result.ok) await audit.record(actorFor(req), 'AVAILABILITY_EXCEPTION_UPDATED', req.params.date); res.status(result.ok ? 200 : 409).json(result); } catch (err) { next(err); }
});
router.put('/slot-overrides/:date/:slot', auth.requireRole('ADMIN'), async (req, res, next) => {
  try { const result = await rules.upsertSlotOverride({ ...req.body, date: req.params.date, slot: req.params.slot }); if (result.ok) await audit.record(actorFor(req), 'SLOT_OVERRIDE_UPDATED', req.params.date + '/' + req.params.slot); res.status(result.ok ? 200 : 409).json(result); } catch (err) { next(err); }
});

router.post('/bookings', auth.requireRole('ADMIN','STAFF'), async (req, res, next) => {
  try {
    res.json(await booking.createManualBooking(req.body, actorFor(req)));
  } catch (err) { next(err); }
});

router.put('/bookings/:id', auth.requireRole('ADMIN','STAFF'), async (req, res, next) => {
  try {
    if (!Number.isSafeInteger(req.body?.revision)) throw require('../util/errors').userError('請重新整理預約資料後再操作 / Refresh the booking before editing.', 409);
    if (typeof req.body.changeReason !== 'string' || !req.body.changeReason.trim()) throw require('../util/errors').userError('請填寫修改原因 / A change reason is required.');
    res.json(await booking.updateBooking({ ...req.body, id: req.params.id }, actorFor(req)));
  } catch (err) { next(err); }
});

router.post('/bookings/:id/cancel', auth.requireRole('ADMIN','STAFF'), async (req, res, next) => {
  try {
    if (!Number.isSafeInteger(req.body?.revision)) throw require('../util/errors').userError('請重新整理預約資料後再操作 / Refresh the booking before editing.', 409);
    if (typeof req.body.reason !== 'string' || !req.body.reason.trim()) throw require('../util/errors').userError('請填寫取消原因 / A cancellation reason is required.');
    res.json(await booking.cancelBooking(req.params.id, req.body, actorFor(req)));
  } catch (err) { next(err); }
});

router.post('/bookings/:id/status', auth.requireRole('ADMIN','STAFF'), async (req, res, next) => {
  try { res.json(await lifecycle.changeStatus(req.params.id, req.body, actorFor(req))); }
  catch (err) { next(err); }
});
router.patch('/bookings/:id/administration', auth.requireRole('ADMIN','STAFF'), async (req, res, next) => {
  try { res.json(await lifecycle.updateAdministration(req.params.id, req.body, actorFor(req))); }
  catch (err) { next(err); }
});
router.post('/bookings/:id/correct-status', auth.requireRole('ADMIN'), async (req, res, next) => {
  try { res.json(await lifecycle.correctStatus(req.params.id, req.body, actorFor(req))); }
  catch (err) { next(err); }
});
router.get('/bookings/:id/notification-preview', auth.requireRole('ADMIN'), async (req, res, next) => {
  try { res.json(await lineNotify.previewManual(req.params.id, req.query.eventType)); }
  catch (err) { next(err); }
});
router.post('/bookings/:id/resend-notification', auth.requireRole('ADMIN'), async (req, res, next) => {
  try {
    const result = await lineNotify.resendManual(req.params.id, req.body?.eventType, req.body?.requestId);
    if (!result.replayed) await audit.record(actorFor(req), 'LINE_NOTIFICATION_QUEUED', req.params.id, { eventType: req.body.eventType });
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/bookings/:id/resend-mail', auth.requireRole('ADMIN','STAFF'), async (req, res, next) => {
  try {
    const result = await booking.resendConfirmation(req.params.id);
    await audit.record(actorFor(req), 'CONFIRMATION_MAIL_RESENT', req.params.id, { mailStatus: result.mailStatus });
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/accounts', auth.requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id,username,display_name,role,active,created_at FROM staff_accounts ORDER BY created_at DESC');
    res.json({ accounts: rows });
  } catch (err) { next(err); }
});
router.post('/accounts', auth.requireRole('ADMIN'), async (req, res, next) => {
  try { const result = await auth.createAccount(req.body); await audit.record(actorFor(req), 'STAFF_ACCOUNT_CREATED', result.id, { role: result.role }); res.status(201).json(result); } catch (err) { next(err); }
});
router.patch('/accounts/:id', auth.requireRole('ADMIN'), async (req, res, next) => {
  try { const result = await auth.setAccountActive(req.params.id, req.body?.active); await audit.record(actorFor(req), 'STAFF_ACCOUNT_ACTIVE_CHANGED', result.id, { active: result.active }); res.json(result); } catch (err) { next(err); }
});
router.get('/system-events', auth.requireRole('ADMIN'), async (req, res, next) => {
  try { res.json({ items: await audit.recent() }); } catch (err) { next(err); }
});

module.exports = router;
