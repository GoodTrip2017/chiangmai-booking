const { pool } = require('../db');
const { userError } = require('../util/errors');

async function ensureCustomer(db, email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  const { rows } = await db.query(
    `INSERT INTO customers(normalized_email) VALUES ($1)
     ON CONFLICT(normalized_email) DO UPDATE SET normalized_email=excluded.normalized_email RETURNING id`,
    [normalized]
  );
  return rows[0].id;
}

async function listCustomers(query = {}) {
  const page = Number(query.page || 1);
  const pageSize = Math.min(100, Number(query.pageSize || 25));
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || search.length > 120) {
    throw userError('顧客搜尋或分頁格式不正確 / Invalid customer search.');
  }
  const params = ['%' + search.replace(/[\\%_]/g, '\\$&') + '%', pageSize, (page - 1) * pageSize];
  const { rows } = await pool.query(
    `SELECT c.id,c.normalized_email,c.internal_note,
      count(b.id)::int AS booking_count,
      count(b.id) FILTER (WHERE b.status='CANCELLED')::int AS cancellation_count,
      count(b.id) FILTER (WHERE b.status='NO_SHOW')::int AS no_show_count,
      count(b.id) FILTER (WHERE b.checked_in_at IS NOT NULL)::int AS checked_in_count,
      min(b.date) FILTER (WHERE b.checked_in_at IS NOT NULL) AS first_recorded_visit,
      max(b.date) FILTER (WHERE b.checked_in_at IS NOT NULL) AS last_recorded_visit,
      bool_or(NULLIF(b.line_user_id,'') IS NOT NULL) AS line_bound
     FROM customers c LEFT JOIN bookings b ON b.customer_id=c.id
     WHERE c.normalized_email ILIKE $1 OR c.id::text ILIKE $1
     GROUP BY c.id ORDER BY last_recorded_visit DESC NULLS LAST,c.id LIMIT $2 OFFSET $3`, params
  );
  return { items: rows, page, pageSize };
}

async function customerDetail(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw userError('顧客編號不正確 / Invalid customer ID.');
  }
  const { rows } = await pool.query('SELECT * FROM customers WHERE id=$1', [id]);
  if (!rows[0]) throw userError('找不到顧客 / Customer not found.', 404);
  const bookings = await pool.query('SELECT id,date,slot,status,pax,actual_pax,checked_in_at,completed_at,created_at FROM bookings WHERE customer_id=$1 ORDER BY date DESC,created_at DESC LIMIT 100', [id]);
  return { customer: rows[0], bookings: bookings.rows };
}

async function updateCustomerNote(id, input, actor) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw userError('顧客編號不正確 / Invalid customer ID.');
  }
  const note = input?.internalNote;
  const reason = input?.reason;
  if (typeof note !== 'string' || note.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note) ||
      typeof reason !== 'string' || !reason.trim() || reason.length > 300 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw userError('內部備註或原因格式不正確 / Invalid note or reason.');
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw userError('請重新整理顧客資料 / Refresh customer details.', 409);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id,internal_note,revision FROM customers WHERE id=$1 FOR UPDATE', [id]);
    if (!rows[0]) throw userError('找不到顧客 / Customer not found.', 404);
    if (rows[0].revision !== input.revision) throw userError('顧客資料已由其他人修改 / Customer details changed; refresh.', 409);
    const { rows: updated } = await client.query('UPDATE customers SET internal_note=$2,revision=revision+1 WHERE id=$1 RETURNING id,internal_note,revision', [id, note.trim()]);
    await client.query('INSERT INTO system_events(actor_type,actor_id,action,target,details) VALUES($1,$2,$3,$4,$5)',
      [actor.type, actor.id, 'CUSTOMER_NOTE_UPDATED', id, { reason: reason.trim(), before: rows[0].internal_note, after: updated[0].internal_note }]);
    await client.query('COMMIT');
    return updated[0];
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

module.exports = { ensureCustomer, listCustomers, customerDetail, updateCustomerNote };
