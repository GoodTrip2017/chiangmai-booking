-- 預約資料表。date/slot 用文字存（'yyyy-MM-dd' / '14:30-16:30'），
-- 與清邁牆上時間一一對應，避免時區換算歧義；規則判斷都在應用層。
CREATE TABLE IF NOT EXISTS bookings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  source       TEXT NOT NULL DEFAULT 'WEB',        -- WEB / WALK_IN / LINE / PHONE
  name         TEXT NOT NULL,
  pax          INTEGER NOT NULL CHECK (pax >= 1),
  date         TEXT NOT NULL,                      -- 'yyyy-MM-dd'（清邁時間）
  slot         TEXT NOT NULL,                      -- '14:30-16:30' 等
  first_time   TEXT NOT NULL DEFAULT '否',          -- '是' / '否'
  line         TEXT NOT NULL DEFAULT '',
  email        TEXT NOT NULL DEFAULT '',
  referral     TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'CONFIRMED',  -- CONFIRMED / CANCELLED（取消為軟刪除）
  note         TEXT NOT NULL DEFAULT '',
  line_user_id TEXT NOT NULL DEFAULT ''            -- 之後 LINE bot 連動用
);

CREATE INDEX IF NOT EXISTS idx_bookings_date_slot ON bookings (date, slot) WHERE status = 'CONFIRMED';
