const { pool } = require('../db');
const { STATUS, CONFIG } = require('../config');
const { userError } = require('../util/errors');
const { getSlotDef, toUtcMs } = require('../util/datetime');
const { capacityCheck } = require('./availability');

const TRANSITIONS = Object.freeze({
  [STATUS.PENDING]: [STATUS.CONFIRMED, STATUS.CHECKED_IN, STATUS.CANCELLED],
  [STATUS.CONFIRMED]: [STATUS.CHECKED_IN, STATUS.CANCELLED, STATUS.NO_SHOW],
  [STATUS.CHECKED_IN]: [STATUS.COMPLETED],
  [STATUS.COMPLETED]: [],
  [STATUS.CANCELLED]: [],
  [STATUS.NO_SHOW]: [],
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw userError('請重新整理預約資料後再操作 / Refresh the booking before editing.', 409);
  return value;
}
function clean(value, max = 300) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw userError('備註格式不正確 / Invalid note.');
  }
  return value.trim();
}

async function recordEvent(client, bookingId, eventType, before, after, reason = '', actor = 'ADMIN') {
  const actorType = typeof actor === 'string' ? actor : actor?.type || 'ADMIN';
  const actorId = typeof actor === 'string' ? '' : actor?.id || '';
  await client.query(
    'INSERT INTO booking_events (booking_id, event_type, actor_type, actor_id, reason, before_data, after_data) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [bookingId, eventType, actorType, actorId, reason, before, after]
  );
}

async function changeStatus(id, body = {}, actor = 'ADMIN') {
  if (typeof id !== 'string' || !UUID.test(id)) throw userError('預約編號格式不正確 / Invalid booking ID.');
  const target = body.status;
  if (!Object.values(STATUS).includes(target)) throw userError('狀態不正確 / Invalid status.');
  const expectedRevision = version(body.revision);
  const reason = body.reason === undefined ? '' : clean(body.reason);
  const actualPax = body.actualPax;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [id]);
    const before = rows[0];
    if (!before) throw userError('找不到這筆預約 / Booking not found.', 404);
    if (before.revision !== expectedRevision) throw userError('預約已由其他人修改，請重新整理 / Booking changed; refresh and try again.', 409);
    if (!TRANSITIONS[before.status]?.includes(target)) throw userError('不能進行這項狀態變更 / This status transition is not allowed.', 409);
    if (target === STATUS.NO_SHOW) {
      const slot = getSlotDef(before.slot);
      if (!slot || Date.now() < toUtcMs(before.date, slot.start)) throw userError('預約時段開始後才能標記未到店 / No-show is available after the visit starts.', 409);
    }
    if (target === STATUS.CANCELLED && !reason) throw userError('請填寫取消原因 / A cancellation reason is required.');
    let guests = null;
    if (target === STATUS.CHECKED_IN) {
      guests = actualPax === undefined ? before.pax : actualPax;
      if (!Number.isSafeInteger(guests) || guests < 1 || guests > CONFIG.MAX_PAX) throw userError('實際到店人數須為 1 至 12 / Actual guests must be between 1 and 12.');
      if (guests > before.pax) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`booking-date:${before.date}`]);
        const capacity = await capacityCheck(client, before.date, before.slot, guests, before.id, { allowPast: true, allowLegacySlot: before.slot });
        if (!capacity.ok) throw userError(capacity.reason, 409);
        if (!reason) throw userError('超出預約人數時請填寫原因 / Give a reason for extra guests.');
      }
    }
    const { rows: updated } = await client.query(
      `UPDATE bookings SET status=$2, actual_pax=COALESCE($3,actual_pax),
       cancel_reason=CASE WHEN $2='CANCELLED' THEN $4 ELSE cancel_reason END,
       no_show_note=CASE WHEN $2='NO_SHOW' THEN $4 ELSE no_show_note END,
       confirmed_at=CASE WHEN $2='CONFIRMED' THEN now() ELSE confirmed_at END,
       checked_in_at=CASE WHEN $2='CHECKED_IN' THEN now() ELSE checked_in_at END,
       completed_at=CASE WHEN $2='COMPLETED' THEN now() ELSE completed_at END,
       cancelled_at=CASE WHEN $2='CANCELLED' THEN now() ELSE cancelled_at END,
       no_show_at=CASE WHEN $2='NO_SHOW' THEN now() ELSE no_show_at END,
       revision=revision+1, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, target, guests, reason]
    );
    await recordEvent(client, id, 'STATUS_CHANGED', before, updated[0], reason, actor);
    await client.query('COMMIT');
    return { ok: true, booking: updated[0] };
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

async function updateAdministration(id, body = {}, actor = 'ADMIN') {
  if (typeof id !== 'string' || !UUID.test(id)) throw userError('預約編號格式不正確 / Invalid booking ID.');
  const expectedRevision = version(body.revision);
  const reason = clean(body.reason);
  if (!reason) throw userError('請填寫變更原因 / A change reason is required.');
  const internalNote = clean(body.internalNote, 2000);
  const assignedStaffId = body.assignedStaffId === '' || body.assignedStaffId === null ? null : body.assignedStaffId;
  if (assignedStaffId !== null && (typeof assignedStaffId !== 'string' || !UUID.test(assignedStaffId))) {
    throw userError('負責人員格式不正確 / Invalid staff assignment.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [id]);
    const before = rows[0];
    if (!before) throw userError('找不到這筆預約 / Booking not found.', 404);
    if (before.revision !== expectedRevision) throw userError('預約已由其他人修改，請重新整理 / Booking changed; refresh and try again.', 409);
    if (assignedStaffId) {
      const { rows: staff } = await client.query("SELECT id FROM staff_accounts WHERE id=$1 AND active=true AND role IN ('ADMIN','STAFF')", [assignedStaffId]);
      if (!staff[0]) throw userError('負責人員已停用或無權限 / Staff member is unavailable.', 409);
    }
    const { rows: updated } = await client.query(
      'UPDATE bookings SET internal_note=$2,assigned_staff_id=$3,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',
      [id, internalNote, assignedStaffId]
    );
    await recordEvent(client, id, 'ADMINISTRATION_UPDATED', before, updated[0], reason, actor);
    await client.query('COMMIT');
    return { ok: true, revision: updated[0].revision };
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

module.exports = { changeStatus, updateAdministration, recordEvent, TRANSITIONS };
