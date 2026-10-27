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

-- Stable discovery IDs keep historical reporting intact when labels change.
CREATE TABLE IF NOT EXISTS discovery_sources (
  id TEXT PRIMARY KEY,
  label_zh TEXT NOT NULL,
  label_en TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO discovery_sources (id, label_zh, label_en, sort_order, active) VALUES
  ('google-maps', 'Google 地圖', 'Google Maps', 10, true),
  ('google-search', 'Google 搜尋', 'Google Search', 20, true),
  ('instagram', 'Instagram', 'Instagram', 30, true),
  ('facebook', 'Facebook', 'Facebook', 40, true),
  ('line', 'LINE', 'LINE', 50, true),
  ('friends-family', '朋友推薦', 'Friends or Family', 60, true),
  ('walk-in-discovery', '路過門市', 'Walk-in Discovery', 70, true),
  ('hotel-accommodation', '飯店或旅宿推薦', 'Hotel or Accommodation', 80, true),
  ('partner-event', '合作店家或活動', 'Partner or Event', 90, true),
  ('previous-visit', '曾經來過', 'Previous Visit', 100, true),
  ('other', '其他', 'Other', 110, true),
  ('prefer-not-to-say', '不願提供', 'Prefer Not to Say', 120, true),
  ('legacy-threads', 'Threads（舊選項）', 'Threads (Legacy)', 200, false),
  ('legacy-goodtrip-web', 'GoodTrip官網（舊選項）', 'GoodTrip Website (Legacy)', 210, false),
  ('legacy-goodtrip-store', 'GoodTrip門市（舊選項）', 'GoodTrip Store (Legacy)', 220, false),
  ('legacy-online-search', '網路搜尋（舊選項）', 'Online Search (Legacy)', 230, false)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discovery_source_id TEXT REFERENCES discovery_sources(id);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discovery_detail TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS entry_source TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS first_touch_source TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS first_touch_medium TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS first_touch_campaign TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS partner_code TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS actual_pax INTEGER CHECK (actual_pax >= 0);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS internal_note TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancel_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS no_show_note TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS no_show_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS original_date TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS original_slot TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS assigned_staff_id UUID;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_id UUID;

-- Backfill only exact legacy selections. Unknown stays unknown; old text remains untouched.
UPDATE bookings SET discovery_source_id = CASE referral
  WHEN 'Instagram' THEN 'instagram'
  WHEN '親友介紹' THEN 'friends-family'
  WHEN 'Threads' THEN 'legacy-threads'
  WHEN 'GoodTrip官網' THEN 'legacy-goodtrip-web'
  WHEN 'GoodTrip門市' THEN 'legacy-goodtrip-store'
  WHEN '網路搜尋' THEN 'legacy-online-search'
  ELSE NULL END
WHERE discovery_source_id IS NULL AND referral <> '' AND (pax BETWEEN 1 AND 12 OR status='CANCELLED');
UPDATE bookings SET entry_source = source WHERE entry_source = 'UNKNOWN' AND source IN ('WEB', 'WALK_IN', 'LINE', 'PHONE') AND (pax BETWEEN 1 AND 12 OR status='CANCELLED');
UPDATE bookings SET confirmed_at = created_at WHERE status = 'CONFIRMED' AND confirmed_at IS NULL AND pax BETWEEN 1 AND 12;

CREATE INDEX IF NOT EXISTS idx_bookings_discovery ON bookings (discovery_source_id, date);
CREATE INDEX IF NOT EXISTS idx_bookings_created ON bookings (created_at);
CREATE INDEX IF NOT EXISTS idx_bookings_status_date ON bookings (status, date);

CREATE TABLE IF NOT EXISTS booking_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id UUID NOT NULL REFERENCES bookings(id),
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  before_data JSONB,
  after_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booking_events_booking ON booking_events (booking_id, id);

CREATE TABLE IF NOT EXISTS notification_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id UUID REFERENCES bookings(id),
  event_type TEXT NOT NULL,
  recipient_kind TEXT NOT NULL,
  recipient_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE,
  retry_key UUID NOT NULL DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'QUEUED',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  response_code TEXT NOT NULL DEFAULT '',
  failure_reason TEXT NOT NULL DEFAULT '',
  message_preview TEXT NOT NULL DEFAULT '',
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_events_schedule ON notification_events (status, scheduled_at);
ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS recipient_id TEXT NOT NULL DEFAULT '';
ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS retry_key UUID NOT NULL DEFAULT gen_random_uuid();

-- Keep existing two-state rows intact; new lifecycle states are added without rewriting history.
CREATE INDEX IF NOT EXISTS idx_bookings_capacity_active ON bookings (date, slot)
  WHERE status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED');
