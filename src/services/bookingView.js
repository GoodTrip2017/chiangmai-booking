/**
 * 預約列的對外版本：剔除只該留在資料庫的秘密欄位（自助取消 token、重放雜湊與鍵），
 * 再回傳給後台 API 或寫進稽核紀錄。
 */
const SECRET_FIELDS = ['cancel_token', 'request_hash', 'request_key'];

function sanitizeBooking(row) {
  if (!row || typeof row !== 'object') return row;
  const copy = { ...row };
  for (const field of SECRET_FIELDS) delete copy[field];
  return copy;
}

module.exports = { sanitizeBooking, SECRET_FIELDS };
