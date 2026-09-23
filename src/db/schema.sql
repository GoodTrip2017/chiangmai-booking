-- 預約資料表。date/slot 用文字存（'yyyy-MM-dd' / '14:00-15:30'），
-- 與清邁牆上時間一一對應，避免時區換算歧義；規則判斷都在應用層。
CREATE TABLE IF NOT EXISTS bookings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  source       TEXT NOT NULL DEFAULT 'WEB',        -- WEB / WALK_IN / LINE / PHONE
  name         TEXT NOT NULL,
  pax          INTEGER NOT NULL CHECK (pax >= 1),
  date         TEXT NOT NULL,                      -- 'yyyy-MM-dd'（清邁時間）
  slot         TEXT NOT NULL,                      -- 新舊時段皆保留原字串
  first_time   TEXT NOT NULL DEFAULT '否',          -- '是' / '否'
  line         TEXT NOT NULL DEFAULT '',
  email        TEXT NOT NULL DEFAULT '',
  referral     TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'CONFIRMED',  -- CONFIRMED / CANCELLED（取消為軟刪除）
  note         TEXT NOT NULL DEFAULT '',
  line_user_id TEXT NOT NULL DEFAULT ''            -- 之後 LINE bot 連動用
);

CREATE INDEX IF NOT EXISTS idx_bookings_date_slot ON bookings (date, slot) WHERE status = 'CONFIRMED';

-- 保留舊預約，不自動刪減；新寫入或修改的單筆不得超過 12 人。
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_pax_limit' AND conrelid = 'bookings'::regclass) THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_pax_limit CHECK (status = 'CANCELLED' OR pax BETWEEN 1 AND 12) NOT VALID;
  END IF;
END $$;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS mail_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS request_key UUID;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS request_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_request_key ON bookings (request_key) WHERE request_key IS NOT NULL;

-- Cookie 僅持有隨機憑證；資料庫只保存其雜湊。
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  credential_version TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS admin_login_limits (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_login_limits_expiry ON admin_login_limits (expires_at);

CREATE TABLE IF NOT EXISTS request_limits (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_limits_expiry ON request_limits (expires_at);

-- 只記錄已通過 LINE 簽名驗證的群組 ID，供登入後台的店員選擇通知群組。
-- 不保存群組對話或成員資料。
CREATE TABLE IF NOT EXISTS line_group_candidates (
  group_id TEXT PRIMARY KEY,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
