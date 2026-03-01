-- ============================================================
-- AI Receptionist — PostgreSQL Schema
-- ============================================================

-- Unified bookings table for all service types
CREATE TABLE IF NOT EXISTS bookings (
  id              SERIAL PRIMARY KEY,
  session_id      TEXT NOT NULL,
  service_type    TEXT NOT NULL CHECK (service_type IN ('restaurant', 'hotel', 'meeting')),
  date            DATE NOT NULL,
  start_time      TIME,                          -- nullable: hotel may not have check-in time
  end_time        TIME,                          -- nullable: hotel checkout stored in check_out_date
  end_date        DATE,                          -- for hotel: LLM puts checkout date here
  people          INTEGER,
  location        TEXT DEFAULT '',
  notes           TEXT DEFAULT '',
  status          TEXT DEFAULT 'pending'
                  CHECK (status IN ('pending', 'confirmed', 'modified', 'cancelled')),
  google_event_id TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Conversation history for multi-turn memory
CREATE TABLE IF NOT EXISTS conversations (
  id          SERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_bookings_session   ON bookings(session_id);
CREATE INDEX IF NOT EXISTS idx_bookings_date      ON bookings(date);
CREATE INDEX IF NOT EXISTS idx_bookings_status    ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_conv_session       ON conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_conv_created       ON conversations(created_at);

-- Auto-update updated_at on bookings
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
