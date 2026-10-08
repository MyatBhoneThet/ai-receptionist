-- ============================================================
-- HISTORICAL — DO NOT RUN AGAINST REAL DATA.
-- This is the pre-platform, single-business schema. It DROPS every table.
-- It is kept only so tests can rebuild an old database and prove that
-- backend/migrations/ upgrades it without losing anything.
-- To create or upgrade a database, run:  cd backend && npm run db:migrate
-- ============================================================
-- ============================================================
-- AI Receptionist — PostgreSQL Schema (Clean Redesign)
-- Run this to wipe and recreate all tables from scratch.
-- ============================================================

-- Drop old tables in safe dependency order
DROP TABLE IF EXISTS audit_logs        CASCADE;
DROP TABLE IF EXISTS conversations     CASCADE;
DROP TABLE IF EXISTS bookings          CASCADE;
DROP TABLE IF EXISTS customers         CASCADE;
DROP TABLE IF EXISTS hotel_rooms       CASCADE;
DROP TABLE IF EXISTS restaurant_tables CASCADE;
DROP TABLE IF EXISTS meeting_rooms     CASCADE;
DROP TABLE IF EXISTS inventory         CASCADE;
DROP TABLE IF EXISTS app_settings      CASCADE;
DROP TABLE IF EXISTS users             CASCADE;

-- ============================================================
-- USERS — Admin / staff login
-- ============================================================
CREATE TABLE users (
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

-- ============================================================
-- CUSTOMERS — Guest contact & preference memory
-- ============================================================
CREATE TABLE customers (
  id           SERIAL PRIMARY KEY,
  name         TEXT,
  phone_number TEXT UNIQUE,
  email        TEXT,
  notes        TEXT DEFAULT '',
  preferences  JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- HOTEL ROOMS — Individual room inventory
-- ============================================================
CREATE TABLE hotel_rooms (
  id              SERIAL PRIMARY KEY,
  room_number     TEXT NOT NULL UNIQUE,   -- e.g. '101', '202', '301'
  room_type       TEXT NOT NULL,          -- 'Standard', 'Deluxe', 'Suite', 'King', 'Twin'
  floor           INTEGER,
  capacity        INTEGER DEFAULT 2,      -- max guests
  price_per_night NUMERIC(10, 2),
  amenities       JSONB DEFAULT '{}',     -- {"wifi": true, "tv": true, "balcony": false}
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- RESTAURANT TABLES — Individual table inventory
-- ============================================================
CREATE TABLE restaurant_tables (
  id           SERIAL PRIMARY KEY,
  table_number TEXT NOT NULL UNIQUE,   -- e.g. 'T1', 'T2'
  capacity     INTEGER DEFAULT 4,
  location     TEXT DEFAULT 'indoor',  -- 'indoor', 'window', 'patio', 'private'
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- MEETING ROOMS — Individual meeting room inventory
-- ============================================================
CREATE TABLE meeting_rooms (
  id         SERIAL PRIMARY KEY,
  room_name  TEXT NOT NULL UNIQUE,   -- e.g. 'Executive Boardroom', 'Meeting Room A'
  room_code  TEXT NOT NULL UNIQUE,   -- short code e.g. 'M1', 'M2', 'BOARD'
  capacity   INTEGER DEFAULT 10,
  equipment  JSONB DEFAULT '{}',     -- {"projector": true, "whiteboard": true}
  is_active  BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- BOOKINGS — All reservations (hotel, restaurant, meeting)
-- Exactly ONE of hotel_room_id / table_id / meeting_room_id
-- will be non-NULL per row, matching the service_type.
-- ============================================================
CREATE TABLE bookings (
  id               SERIAL PRIMARY KEY,
  session_id       TEXT NOT NULL,
  service_type     TEXT NOT NULL CHECK (service_type IN ('hotel', 'restaurant', 'meeting')),

  -- Resource FK (one per booking)
  hotel_room_id    INTEGER REFERENCES hotel_rooms(id)       ON DELETE SET NULL,
  table_id         INTEGER REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  meeting_room_id  INTEGER REFERENCES meeting_rooms(id)     ON DELETE SET NULL,

  -- Guest info
  customer_id      INTEGER REFERENCES customers(id)         ON DELETE SET NULL,
  reservation_name TEXT,
  contact_phone    TEXT,
  contact_email    TEXT,
  people           INTEGER DEFAULT 1,

  -- Timing
  -- Hotel:      date = check-in,    end_date = check-out
  -- Restaurant: date = booking date, start_time/end_time = slot
  -- Meeting:    date = booking date, start_time/end_time = slot
  date             DATE,
  end_date         DATE,
  start_time       TIME,
  end_time         TIME,

  -- Status & flags
  status           TEXT DEFAULT 'pending'
                   CHECK (status IN ('pending', 'confirmed', 'modified', 'cancelled', 'checked_in', 'no_show')),
  waitlisted       BOOLEAN DEFAULT FALSE,
  notes            TEXT DEFAULT '',

  -- Google Calendar sync
  google_event_id  TEXT,

  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CONVERSATIONS — Full chat history per session
-- ============================================================
CREATE TABLE conversations (
  id         SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- APP SETTINGS — Admin-configurable key/value store
-- ============================================================
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AUDIT LOGS — Immutable admin action trail
-- ============================================================
CREATE TABLE audit_logs (
  id           SERIAL PRIMARY KEY,
  actor_email  TEXT,
  action       TEXT NOT NULL,   -- 'create', 'update', 'cancel', 'status_change', 'delete'
  entity       TEXT NOT NULL,   -- 'booking', 'hotel_room', 'restaurant_table', 'meeting_room'
  entity_id    INTEGER,         -- ID of the affected row
  before_state JSONB DEFAULT '{}'::jsonb,
  after_state  JSONB DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_bookings_session      ON bookings(session_id);
CREATE INDEX idx_bookings_date         ON bookings(date);
CREATE INDEX idx_bookings_status       ON bookings(status);
CREATE INDEX idx_bookings_service      ON bookings(service_type);
CREATE INDEX idx_bookings_hotel_room   ON bookings(hotel_room_id);
CREATE INDEX idx_bookings_table        ON bookings(table_id);
CREATE INDEX idx_bookings_meeting_room ON bookings(meeting_room_id);
CREATE INDEX idx_bookings_customer     ON bookings(customer_id);
CREATE INDEX idx_conv_session          ON conversations(session_id);
CREATE INDEX idx_conv_created          ON conversations(created_at);
CREATE INDEX idx_users_email           ON users(email);
CREATE INDEX idx_customers_phone_number ON customers(phone_number);
CREATE INDEX idx_audit_entity          ON audit_logs(entity, entity_id);
CREATE INDEX idx_audit_created         ON audit_logs(created_at DESC);

-- ============================================================
-- TRIGGERS — Auto-update updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookings_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER hotel_rooms_updated_at
  BEFORE UPDATE ON hotel_rooms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER restaurant_tables_updated_at
  BEFORE UPDATE ON restaurant_tables
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER meeting_rooms_updated_at
  BEFORE UPDATE ON meeting_rooms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
