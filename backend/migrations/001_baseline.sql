-- 001 — Baseline. Brings any existing deployment (or an empty database) to the
-- pre-platform schema WITHOUT dropping anything. Every statement is additive
-- and idempotent; db/schema.sql (drop-and-recreate) must never be used on real data.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT,
  phone_number  TEXT,
  role          TEXT DEFAULT 'customer' CHECK (role IN ('customer', 'staff', 'admin')),
  preferences   JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customers (
  id           SERIAL PRIMARY KEY,
  name         TEXT,
  phone_number TEXT UNIQUE,
  email        TEXT,
  notes        TEXT DEFAULT '',
  preferences  JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Older deployments used customers.phone; keep the rows, rename the column.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema() AND table_name = 'customers' AND column_name = 'phone_number')
     AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema() AND table_name = 'customers' AND column_name = 'phone') THEN
    ALTER TABLE customers RENAME COLUMN phone TO phone_number;
  END IF;
END;
$$;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS hotel_rooms (
  id              SERIAL PRIMARY KEY,
  room_number     TEXT NOT NULL UNIQUE,
  room_type       TEXT NOT NULL,
  floor           INTEGER,
  capacity        INTEGER DEFAULT 2,
  price_per_night NUMERIC(10, 2),
  amenities       JSONB DEFAULT '{}',
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS restaurant_tables (
  id           SERIAL PRIMARY KEY,
  table_number TEXT NOT NULL UNIQUE,
  capacity     INTEGER DEFAULT 4,
  location     TEXT DEFAULT 'indoor',
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS meeting_rooms (
  id         SERIAL PRIMARY KEY,
  room_name  TEXT NOT NULL UNIQUE,
  room_code  TEXT NOT NULL UNIQUE,
  capacity   INTEGER DEFAULT 10,
  equipment  JSONB DEFAULT '{}',
  is_active  BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bookings (
  id               SERIAL PRIMARY KEY,
  session_id       TEXT NOT NULL,
  service_type     TEXT NOT NULL CHECK (service_type IN ('hotel', 'restaurant', 'meeting')),
  hotel_room_id    INTEGER REFERENCES hotel_rooms(id)       ON DELETE SET NULL,
  table_id         INTEGER REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  meeting_room_id  INTEGER REFERENCES meeting_rooms(id)     ON DELETE SET NULL,
  customer_id      INTEGER REFERENCES customers(id)         ON DELETE SET NULL,
  reservation_name TEXT,
  contact_phone    TEXT,
  contact_email    TEXT,
  people           INTEGER DEFAULT 1,
  date             DATE,
  end_date         DATE,
  start_time       TIME,
  end_time         TIME,
  status           TEXT DEFAULT 'pending',
  waitlisted       BOOLEAN DEFAULT FALSE,
  notes            TEXT DEFAULT '',
  google_event_id  TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hotel_room_id   INTEGER REFERENCES hotel_rooms(id)       ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS table_id        INTEGER REFERENCES restaurant_tables(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS meeting_room_id INTEGER REFERENCES meeting_rooms(id)     ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_id     INTEGER REFERENCES customers(id)         ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reservation_name TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS contact_phone   TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS contact_email   TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS end_date        DATE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS waitlisted      BOOLEAN DEFAULT FALSE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notes           TEXT DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS google_event_id TEXT;
UPDATE bookings SET waitlisted = FALSE WHERE waitlisted IS NULL;

CREATE TABLE IF NOT EXISTS conversations (
  id         SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id           SERIAL PRIMARY KEY,
  actor_email  TEXT,
  action       TEXT NOT NULL,
  entity       TEXT NOT NULL,
  entity_id    INTEGER,
  before_state JSONB DEFAULT '{}'::jsonb,
  after_state  JSONB DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_bookings_session ON bookings(session_id);
CREATE INDEX IF NOT EXISTS idx_bookings_date    ON bookings(date);
CREATE INDEX IF NOT EXISTS idx_bookings_status  ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_conv_session     ON conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_created    ON audit_logs(created_at DESC);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bookings','hotel_rooms','restaurant_tables','meeting_rooms','customers','users'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_updated_at' AND tgrelid = t::regclass) THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at()', t || '_updated_at', t);
    END IF;
  END LOOP;
END;
$$;
