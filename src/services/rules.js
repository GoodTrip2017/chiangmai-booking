const { pool } = require('../db');
const dt = require('../util/datetime');
const { userError } = require('../util/errors');

function minute(time) {
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw userError('時間格式不正確 / Invalid time.');
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}
function hhmm(total) { return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0'); }
function generateSlots(settings) {
  const opening = minute(settings.open_time), closing = minute(settings.close_time);
  if (closing <= opening) throw userError('營業結束時間必須晚於開始時間 / Closing time must follow opening time.');
  const duration = settings.service_minutes, interval = settings.interval_minutes;
  if (!Number.isSafeInteger(duration) || duration < 15 || duration > 240 ||
      !Number.isSafeInteger(interval) || interval < 15 || interval > 240) throw userError('服務與時段間隔需為 15–240 分鐘 / Invalid slot length or interval.');
  const slots = [];
  for (let start = opening; start < closing && slots.length < 96; start += interval) {
    const end = start + duration;
    if (end > 1439 || (settings.finish_before_close && end > closing)) break;
    slots.push({ start: hhmm(start), end: hhmm(end), slot: hhmm(start) + '-' + hhmm(end) });
  }
  return slots;
}
function validateSettings(input) {
  const settings = {
    open_time: input?.open_time,
    close_time: input?.close_time,
    service_minutes: Number(input?.service_minutes),
    interval_minutes: Number(input?.interval_minutes),
    max_pax: Number(input?.max_pax),
    closed_weekdays: input?.closed_weekdays,
    max_advance_days: input?.max_advance_days === null || input?.max_advance_days === '' ? null : Number(input?.max_advance_days),
    cutoff_minutes: Number(input?.cutoff_minutes),
    finish_before_close: input?.finish_before_close,
  };
  generateSlots(settings);
  if (!Number.isSafeInteger(settings.max_pax) || settings.max_pax < 1 || settings.max_pax > 12 ||
      !Array.isArray(settings.closed_weekdays) || settings.closed_weekdays.some(day => !Number.isSafeInteger(day) || day < 1 || day > 7) ||
      new Set(settings.closed_weekdays).size !== settings.closed_weekdays.length ||
      (settings.max_advance_days !== null && (!Number.isSafeInteger(settings.max_advance_days) || settings.max_advance_days < 1 || settings.max_advance_days > 730)) ||
      !Number.isSafeInteger(settings.cutoff_minutes) || settings.cutoff_minutes < 0 || settings.cutoff_minutes > 1440 ||
      typeof settings.finish_before_close !== 'boolean') throw userError('營業設定格式不正確 / Invalid availability settings.');
  return settings;
}

async function readSettings(db = pool) {
  const { rows } = await db.query('SELECT * FROM availability_settings WHERE id=1');
  if (!rows[0]) throw new Error('availability settings missing');
  return rows[0];
}
async function dayRules(db, date, proposedSettings) {
  if (!dt.isValidDateStr(date)) throw userError('日期格式不正確 / Invalid date.');
  const settings = proposedSettings || await readSettings(db);
  const { rows } = await db.query('SELECT * FROM availability_exceptions WHERE date=$1', [date]);
  const exception = rows[0];
  const closed = exception ? exception.closed : settings.closed_weekdays.includes(dt.isoWeekday(date));
  const effective = { ...settings,
    open_time: exception?.open_time || settings.open_time,
    close_time: exception?.close_time || settings.close_time,
    max_pax: exception?.max_pax || settings.max_pax,
  };
  const slots = closed ? [] : generateSlots(effective);
  const { rows: overrides } = await db.query('SELECT * FROM slot_overrides WHERE date=$1', [date]);
  const bySlot = new Map(overrides.map(row => [row.slot, row]));
  return { date, closed, reason: exception?.reason || '', settings: effective,
    slots: slots.map(slot => ({ ...slot, maxPax: bySlot.get(slot.slot)?.max_pax ?? effective.max_pax,
      blocked: bySlot.get(slot.slot)?.blocked || false, reason: bySlot.get(slot.slot)?.reason || '' })) };
}

function isBookableTime(rules, date, slot, { allowPast = false } = {}) {
  const def = rules.slots.find(row => row.slot === slot);
  if (rules.closed || !def || def.blocked || def.maxPax === 0) return { ok: false, reason: '此日期或時段目前未開放預約 / This visit time is unavailable.' };
  if (!allowPast) {
    const start = dt.toUtcMs(date, def.start);
    if (start - Date.now() <= rules.settings.cutoff_minutes * 60000) return { ok: false, reason: '該時段已過預約截止時間 / Booking cutoff has passed.' };
    if (rules.settings.max_advance_days !== null &&
        date > dt.addDaysStr(dt.todayStr(), rules.settings.max_advance_days)) return { ok: false, reason: '超過最早開放預約日期 / This date is too far in advance.' };
  }
  return { ok: true, def };
}

async function affectedBookings(db, proposedSettings) {
  const { rows } = await db.query(
    "SELECT id,date,slot,pax,actual_pax,status FROM bookings WHERE date >= $1 AND status IN ('PENDING','CONFIRMED','CHECKED_IN') ORDER BY date,slot,id",
    [dt.todayStr()]
  );
  const days = new Map();
  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }
  const affected = [];
  for (const row of rows) {
    if (!days.has(row.date)) days.set(row.date, await dayRules(db, row.date, proposedSettings));
    const rules = days.get(row.date);
    const slot = rules.slots.find(item => item.slot === row.slot);
    let reason = !slot ? 'SLOT_REMOVED' : slot.blocked ? 'BLOCKED' : '';
    if (!reason) {
      const points = [slot.start, ...byDate.get(row.date).map(other => dt.getSlotDef(other.slot)?.start),
        ...rules.slots.map(item => item.start)].filter(point => point && point >= slot.start && point < slot.end);
      for (const point of new Set(points)) {
        const occupancy = byDate.get(row.date).filter(other => {
          const interval = dt.getSlotDef(other.slot);
          return interval && interval.start <= point && point < interval.end;
        }).reduce((sum, other) => sum + Math.max(other.pax, other.actual_pax || 0), 0);
        const maxPax = Math.min(slot.maxPax, ...rules.slots.filter(item => item.start <= point && point < item.end)
          .map(item => item.blocked ? 0 : item.maxPax));
        if (occupancy > maxPax) { reason = 'CAPACITY_REDUCED'; break; }
      }
    }
    if (reason) affected.push({ id: row.id, date: row.date, slot: row.slot, pax: row.pax, reason });
  }
  return affected;
}

async function updateSettings(input) {
  const settings = validateSettings(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['availability-settings']);
    const previousSettings = await readSettings(client);
    const previouslyAffected = new Set((await affectedBookings(client, previousSettings)).map(row => row.id));
    const affected = (await affectedBookings(client, settings)).filter(row => !previouslyAffected.has(row.id));
    if (affected.length && input.acknowledgeAffected !== true) {
      await client.query('ROLLBACK');
      return { ok: false, affected };
    }
    const { rows } = await client.query(
      `UPDATE availability_settings SET open_time=$1,close_time=$2,service_minutes=$3,interval_minutes=$4,
       max_pax=$5,closed_weekdays=$6,max_advance_days=$7,cutoff_minutes=$8,finish_before_close=$9,updated_at=now()
       WHERE id=1 RETURNING *`,
      [settings.open_time, settings.close_time, settings.service_minutes, settings.interval_minutes,
        settings.max_pax, settings.closed_weekdays, settings.max_advance_days, settings.cutoff_minutes, settings.finish_before_close]
    );
    await client.query('INSERT INTO availability_rule_events(rule_type,target,before_data,after_data) VALUES($1,$2,$3,$4)',
      ['SETTINGS', '', previousSettings, rows[0]]);
    await client.query('COMMIT');
    return { ok: true, settings: rows[0], affected };
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

async function upsertException(input) {
  if (!dt.isValidDateStr(input?.date) || typeof input.closed !== 'boolean' ||
      (input.open_time && minute(input.open_time) < 0) || (input.close_time && minute(input.close_time) < 0) ||
      (input.max_pax !== null && input.max_pax !== undefined && (!Number.isSafeInteger(input.max_pax) || input.max_pax < 1 || input.max_pax > 12)) ||
      typeof input.reason !== 'string' || input.reason.length > 200) throw userError('特殊營業日資料不正確 / Invalid date exception.');
  if (input.open_time && input.close_time && minute(input.open_time) >= minute(input.close_time)) throw userError('特殊營業時間不正確 / Invalid special hours.');
  const client = await pool.connect();
  try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`booking-date:${input.date}`]);
  const settings = await readSettings(client);
  const before = (await client.query('SELECT * FROM availability_exceptions WHERE date=$1', [input.date])).rows[0] || null;
  const previous = new Set((await affectedBookings(client, settings)).filter(row => row.date === input.date).map(row => row.id));
  const { rows } = await client.query(
    `INSERT INTO availability_exceptions(date,closed,open_time,close_time,max_pax,reason)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (date) DO UPDATE SET closed=excluded.closed,
     open_time=excluded.open_time,close_time=excluded.close_time,max_pax=excluded.max_pax,
     reason=excluded.reason,updated_at=now() RETURNING *`,
    [input.date, input.closed, input.open_time || null, input.close_time || null, input.max_pax ?? null, input.reason.trim()]
  );
  const affected = (await affectedBookings(client, settings)).filter(row => row.date === input.date && !previous.has(row.id));
  if (affected.length && input.acknowledgeAffected !== true) {
    await client.query('ROLLBACK'); return { ok: false, affected };
  }
  await client.query('INSERT INTO availability_rule_events(rule_type,target,before_data,after_data) VALUES($1,$2,$3,$4)',
    ['DATE_EXCEPTION', input.date, before, rows[0]]);
  await client.query('COMMIT');
  return { ok: true, exception: rows[0], affected };
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

async function upsertSlotOverride(input) {
  if (!dt.isValidDateStr(input?.date) || typeof input.slot !== 'string' || !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(input.slot) ||
      typeof input.blocked !== 'boolean' ||
      (input.max_pax !== null && input.max_pax !== undefined && (!Number.isSafeInteger(input.max_pax) || input.max_pax < 0 || input.max_pax > 12)) ||
      typeof input.reason !== 'string' || input.reason.length > 200) throw userError('時段調整資料不正確 / Invalid slot override.');
  const client = await pool.connect();
  try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`booking-date:${input.date}`]);
  const settings = await readSettings(client);
  const before = (await client.query('SELECT * FROM slot_overrides WHERE date=$1 AND slot=$2', [input.date, input.slot])).rows[0] || null;
  const previous = new Set((await affectedBookings(client, settings)).filter(row => row.date === input.date).map(row => row.id));
  const { rows } = await client.query(
    `INSERT INTO slot_overrides(date,slot,max_pax,blocked,reason) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT(date,slot) DO UPDATE SET max_pax=excluded.max_pax,blocked=excluded.blocked,
     reason=excluded.reason,updated_at=now() RETURNING *`,
    [input.date, input.slot, input.max_pax ?? null, input.blocked, input.reason.trim()]
  );
  const affected = (await affectedBookings(client, settings)).filter(row => row.date === input.date && !previous.has(row.id));
  if (affected.length && input.acknowledgeAffected !== true) {
    await client.query('ROLLBACK'); return { ok: false, affected };
  }
  await client.query('INSERT INTO availability_rule_events(rule_type,target,before_data,after_data) VALUES($1,$2,$3,$4)',
    ['SLOT_OVERRIDE', input.date + '/' + input.slot, before, rows[0]]);
  await client.query('COMMIT');
  return { ok: true, override: rows[0], affected };
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

module.exports = { minute, generateSlots, validateSettings, readSettings, dayRules, isBookableTime,
  affectedBookings, updateSettings, upsertException, upsertSlotOverride };
