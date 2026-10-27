const { pool } = require('../db');
const { STATUS } = require('../config');
const dt = require('../util/datetime');
const { userError } = require('../util/errors');

function filters(query = {}) {
  const from = query.from || dt.todayStr();
  const to = query.to || from;
  if (!dt.isValidDateStr(from) || !dt.isValidDateStr(to) || from > to) throw userError('日期區間不正確 / Invalid date range.');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw userError('日期區間最多一年 / Date range is limited to one year.');
  const basis = query.basis || 'visit';
  if (!['visit', 'created'].includes(basis)) throw userError('日期基準不正確 / Invalid date basis.');
  const status = query.status || '';
  if (status && !Object.values(STATUS).includes(status)) throw userError('狀態篩選不正確 / Invalid status filter.');
  const discovery = query.discovery || '';
  if (typeof discovery !== 'string' || discovery.length > 80 || !/^[a-z0-9-]*$/.test(discovery)) throw userError('來源篩選不正確 / Invalid source filter.');
  const search = query.search || '';
  if (typeof search !== 'string' || search.length > 120) throw userError('搜尋字串過長 / Search is too long.');
  return { from, to, basis, status, discovery, search: search.trim() };
}

function where(f, { search = false, deidentified = false } = {}) {
  const dateExpr = f.basis === 'created' ? "(b.created_at AT TIME ZONE 'Asia/Bangkok')::date" : 'b.date::date';
  const values = [f.from, f.to];
  const parts = [`${dateExpr} BETWEEN $1::date AND $2::date`];
  if (f.status) { values.push(f.status); parts.push(`b.status=$${values.length}`); }
  if (f.discovery) { values.push(f.discovery); parts.push(`b.discovery_source_id=$${values.length}`); }
  if (search && f.search) {
    values.push('%' + f.search.replace(/[\\%_]/g, '\\$&') + '%');
    parts.push(deidentified ? `b.id::text ILIKE $${values.length}` :
      `(b.id::text ILIKE $${values.length} OR b.name ILIKE $${values.length} OR b.email ILIKE $${values.length})`);
  }
  return { clause: parts.join(' AND '), values };
}

async function listBookings(query = {}, role = 'ADMIN') {
  const f = filters(query);
  const page = Number(query.page || 1);
  const pageSize = Math.min(100, Number(query.pageSize || 25));
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(pageSize) || pageSize < 1) throw userError('分頁參數不正確 / Invalid pagination.');
  const deidentified = role === 'ANALYST';
  const w = where(f, { search: true, deidentified });
  const { rows } = await pool.query(
    `SELECT b.id,b.created_at,b.updated_at,b.revision,b.source,b.entry_source,b.name,b.pax,b.actual_pax,
      b.date,b.slot,b.email,b.line,b.status,b.referral,b.discovery_source_id,b.discovery_detail,
      b.note,b.internal_note,b.cancel_reason,b.no_show_note,b.mail_status,b.assigned_staff_id,
      b.first_touch_source,b.first_touch_medium,b.first_touch_campaign,b.partner_code,b.campaign_code,
      d.label_zh AS discovery_zh,d.label_en AS discovery_en
     FROM bookings b LEFT JOIN discovery_sources d ON d.id=b.discovery_source_id
     WHERE ${w.clause} ORDER BY b.date DESC,b.slot DESC,b.created_at DESC,b.id DESC
     LIMIT $${w.values.length + 1} OFFSET $${w.values.length + 2}`,
    [...w.values, pageSize, (page - 1) * pageSize]
  );
  const total = await pool.query(`SELECT count(*)::int AS total FROM bookings b WHERE ${w.clause}`, w.values);
  const items = deidentified ? rows.map(row => ({ id: row.id, created_at: row.created_at,
    date: row.date, slot: row.slot, status: row.status, pax: row.pax, actual_pax: row.actual_pax,
    entry_source: row.entry_source, discovery_source_id: row.discovery_source_id,
    discovery_zh: row.discovery_zh, discovery_en: row.discovery_en })) : rows;
  return { items, total: total.rows[0].total, page, pageSize, filters: f };
}

async function bookingDetail(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw userError('預約編號格式不正確 / Invalid booking ID.');
  const [booking, history, notifications] = await Promise.all([
    pool.query('SELECT * FROM bookings WHERE id=$1', [id]),
    pool.query('SELECT id,event_type,actor_type,reason,created_at,before_data,after_data FROM booking_events WHERE booking_id=$1 ORDER BY id DESC LIMIT 100', [id]),
    pool.query('SELECT id,event_type,recipient_kind,status,attempt_count,response_code,failure_reason,scheduled_at,attempted_at FROM notification_events WHERE booking_id=$1 ORDER BY id DESC LIMIT 100', [id]),
  ]);
  if (!booking.rows[0]) throw userError('找不到這筆預約 / Booking not found.', 404);
  return { booking: booking.rows[0], history: history.rows, notifications: notifications.rows };
}

async function analytics(query = {}) {
  const f = filters(query);
  const w = where(f);
  const basisExpr = f.basis === 'created' ? "(b.created_at AT TIME ZONE 'Asia/Bangkok')::date" : 'b.date::date';
  const { rows: summary } = await pool.query(
    `SELECT count(*)::int AS bookings,
      COALESCE(sum(pax),0)::int AS booked_guests,
      count(*) FILTER (WHERE checked_in_at IS NOT NULL)::int AS checked_in_bookings,
      (sum(b.actual_pax) FILTER (WHERE b.checked_in_at IS NOT NULL))::int AS actual_guests,
      count(*) FILTER (WHERE status='COMPLETED')::int AS completed_bookings,
      count(*) FILTER (WHERE status='CANCELLED')::int AS cancellations,
      count(*) FILTER (WHERE status='NO_SHOW')::int AS no_shows,
      count(*) FILTER (WHERE discovery_source_id IS NULL)::int AS unknown_discovery,
      count(*) FILTER (WHERE checked_in_at IS NOT NULL AND actual_pax IS NULL)::int AS missing_actual_guests,
      count(*) FILTER (WHERE status IN ('PENDING','CONFIRMED') AND date::date < (now() AT TIME ZONE 'Asia/Bangkok')::date)::int AS overdue_unresolved
     FROM bookings b WHERE ${w.clause}`, w.values
  );
  const { rows: trend } = await pool.query(
    `SELECT ${basisExpr} AS day,count(*)::int AS bookings,COALESCE(sum(pax),0)::int AS booked_guests,
      count(*) FILTER (WHERE checked_in_at IS NOT NULL)::int AS checked_in_bookings,
      (sum(b.actual_pax) FILTER (WHERE b.checked_in_at IS NOT NULL))::int AS actual_guests
     FROM bookings b WHERE ${w.clause} GROUP BY day ORDER BY day`, w.values
  );
  const { rows: discovery } = await pool.query(
    `SELECT COALESCE(d.id,'unknown') AS id,COALESCE(d.label_zh,'未知') AS label_zh,
      COALESCE(d.label_en,'Unknown') AS label_en,count(*)::int AS bookings,
      COALESCE(sum(b.pax),0)::int AS booked_guests,
      count(*) FILTER (WHERE b.checked_in_at IS NOT NULL)::int AS checked_in_bookings,
      (sum(b.actual_pax) FILTER (WHERE b.checked_in_at IS NOT NULL))::int AS actual_guests
     FROM bookings b LEFT JOIN discovery_sources d ON d.id=b.discovery_source_id
     WHERE ${w.clause} GROUP BY d.id,d.label_zh,d.label_en ORDER BY bookings DESC,id`, w.values
  );
  const { rows: entries } = await pool.query(
    `SELECT COALESCE(NULLIF(b.entry_source,''),'UNKNOWN') AS source,count(*)::int AS bookings,
      COALESCE(sum(b.pax),0)::int AS booked_guests FROM bookings b WHERE ${w.clause}
     GROUP BY 1 ORDER BY bookings DESC`, w.values
  );
  const { rows: tracked } = await pool.query(
    `SELECT COALESCE(NULLIF(b.first_touch_source,''),'UNKNOWN') AS source,
      COALESCE(NULLIF(b.first_touch_medium,''),'UNKNOWN') AS medium,
      COALESCE(NULLIF(b.first_touch_campaign,''),'UNKNOWN') AS campaign,
      COALESCE(NULLIF(b.partner_code,''),NULLIF(b.campaign_code,''),'UNKNOWN') AS code,
      count(*)::int AS bookings,COALESCE(sum(b.pax),0)::int AS booked_guests,
      count(*) FILTER (WHERE b.checked_in_at IS NOT NULL)::int AS checked_in_bookings,
      (sum(b.actual_pax) FILTER (WHERE b.checked_in_at IS NOT NULL))::int AS actual_guests
     FROM bookings b WHERE ${w.clause} GROUP BY 1,2,3,4 ORDER BY bookings DESC`, w.values
  );
  const { rows: visitors } = await pool.query(
    `WITH first_visit AS (
       SELECT customer_id,min(date) AS first_date FROM bookings
       WHERE customer_id IS NOT NULL AND checked_in_at IS NOT NULL GROUP BY customer_id
     )
     SELECT count(DISTINCT b.customer_id) FILTER (WHERE b.checked_in_at IS NOT NULL AND b.date=first_visit.first_date)::int AS first_recorded_visitors,
       count(DISTINCT b.customer_id) FILTER (WHERE b.checked_in_at IS NOT NULL AND b.date>first_visit.first_date)::int AS returning_visitors
     FROM bookings b LEFT JOIN first_visit ON first_visit.customer_id=b.customer_id WHERE ${w.clause}`, w.values
  );
  return {
    filters: f, summary: { ...summary[0], ...visitors[0] }, trend, discovery, entries, tracked,
    definitions: {
      bookings: '預約筆數 / Booking orders: number of booking records in the chosen date basis.',
      booked_guests: '預約人數 / Booked guests: sum of booked group sizes; cancellations are included unless filtered out.',
      checked_in_bookings: '完成到店筆數 / Checked-in bookings: records with a valid check-in timestamp, counted once even after completion.',
      actual_guests: '實際到店人數 / Actual guests: sum of recorded check-in counts; unknown values stay null.',
      cancellations: '取消筆數 / Cancellations: currently cancelled records, measured by the selected date basis.',
      no_shows: '未到筆數 / No-shows: staff-marked no-shows only; unresolved past bookings remain separate.',
      attribution: '得知管道由客人自行填寫；入口由系統寫入；首次可辨識 UTM 僅為同一瀏覽器工作階段的連結參數，不代表跨裝置的完整歸因。 / Discovery is self-reported, entry is system-recorded, and first-touch UTM is limited to the current browser session.',
      first_recorded_visitors: '可追溯期間首次到店的預約者 / First recorded visitors: unique email-linked contacts whose earliest recorded check-in is in this period; this may not be their true first visit.',
      returning_visitors: '回訪預約者 / Returning visitors: unique email-linked contacts checked in after an earlier recorded check-in.',
    },
  };
}

function csvCell(value) {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = /^[\s]*[=+\-@\t\r\n]/.test(raw) ? "'" + raw : raw;
  return '"' + safe.replace(/"/g, '""') + '"';
}
async function exportBookingsCsv(query = {}) {
  const f = filters(query);
  const w = where(f, { search: true });
  const { rows } = await pool.query(
    `SELECT b.id,b.date,b.slot,b.name,b.email,b.line,b.pax,b.actual_pax,b.status,
       b.discovery_source_id,b.discovery_detail,b.entry_source,b.first_touch_source,
       b.first_touch_medium,b.first_touch_campaign,b.partner_code,b.campaign_code,
       to_char(b.created_at AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD HH24:MI:SS') AS created_bkk
     FROM bookings b WHERE ${w.clause}
     ORDER BY b.date DESC,b.slot DESC,b.created_at DESC,b.id DESC LIMIT 50001`, w.values
  );
  if (rows.length > 50000) throw userError('匯出超過 50,000 筆，請縮小日期區間 / Narrow the date range for export.', 413);
  const lines = [
    ['報表 / Report','預約明細 / Booking details'],
    ['時區 / Timezone','Asia/Bangkok (GMT+7)'],
    ['匯出時間 / Exported at', new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Bangkok', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' }).format(new Date())],
    ['日期基準 / Date basis', f.basis === 'visit' ? '到店日期 / Visit date' : '建立日期 / Created date'],
    ['區間 / Range', f.from + ' – ' + f.to],
    ['定義 / Definition','每一列代表一筆預約；實際到店人數未記錄時留空 / One row per booking; unknown actual guests remain blank.'],
    [],
    ['預約編號 / Booking ID','到店日期 / Visit Date','時段 / Time Slot','姓名 / Name','Email',
      'LINE 聯絡 / LINE Contact','預約人數 / Booked Guests','實際人數 / Actual Guests','狀態 / Status',
      '得知管道 ID / Discovery ID','來源補充 / Discovery Detail','預約入口 / Entry Source',
      '首次 UTM Source','首次 UTM Medium','首次 UTM Campaign','合作代碼 / Partner Code',
      '活動代碼 / Campaign Code','建立時間（清邁） / Created At (Bangkok)'],
    ...rows.map(row => [row.id,row.date,row.slot,row.name,row.email,row.line,row.pax,row.actual_pax,row.status,
      row.discovery_source_id,row.discovery_detail,row.entry_source,row.first_touch_source,
      row.first_touch_medium,row.first_touch_campaign,row.partner_code,row.campaign_code,row.created_bkk]),
  ];
  return '\ufeff' + lines.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { filters, listBookings, bookingDetail, analytics, csvCell, exportBookingsCsv };
