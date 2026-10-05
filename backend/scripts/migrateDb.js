import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pkg from 'pg';

const { Pool } = pkg;

const isProduction = process.env.NODE_ENV === 'production';
const requiresSsl = process.env.DATABASE_URL?.includes('sslmode=');
const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction || requiresSsl ? { rejectUnauthorized } : false,
});

async function run(sql) {
  await pool.query(sql);
}

async function migrate() {
  console.log('🔄 Migrating database...');

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id              SERIAL PRIMARY KEY,
      email           TEXT UNIQUE NOT NULL,
      password_hash   TEXT NOT NULL,
      name            TEXT,
      phone_number    TEXT,
      role            TEXT DEFAULT 'customer' CHECK (role IN ('customer','staff','admin')),
      preferences     JSONB DEFAULT '{}',
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS customers (
      id              SERIAL PRIMARY KEY,
      phone_number    TEXT UNIQUE,
      name            TEXT,
      preferences     JSONB DEFAULT '{}',
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await run(readFileSync(new URL('../../db/migrations/20261005_customer_phone_number.sql', import.meta.url), 'utf8'));

  await run(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS end_date DATE;`);
  await run(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS waitlisted BOOLEAN DEFAULT FALSE;`);
  await run(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS contact_email TEXT;`);
  await run(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS contact_phone TEXT;`);
  await run(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS inventory_id INTEGER;`);
  await run(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);`);
  await run(`ALTER TABLE bookings DROP COLUMN IF EXISTS location;`);

  await run(`ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;`);
  await run(`
    ALTER TABLE bookings
    ADD CONSTRAINT bookings_status_check
    CHECK (status IN ('pending', 'confirmed', 'modified', 'cancelled', 'checked_in', 'no_show'));
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          SERIAL PRIMARY KEY,
      session_id  TEXT NOT NULL,
      role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content     TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS inventory (
      id            SERIAL PRIMARY KEY,
      category      TEXT NOT NULL CHECK (category IN ('room','table','meeting')),
      code          TEXT NOT NULL,
      name          TEXT,
      capacity      INTEGER DEFAULT 0,
      quantity      INTEGER DEFAULT 1,
      metadata      JSONB DEFAULT '{}',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(category, code)
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key         TEXT PRIMARY KEY,
      value       JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id            SERIAL PRIMARY KEY,
      actor_email   TEXT,
      action        TEXT NOT NULL,
      entity        TEXT NOT NULL,
      before_state  JSONB DEFAULT '{}'::jsonb,
      after_state   JSONB DEFAULT '{}'::jsonb,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_bookings_session ON bookings(session_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);
    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
    CREATE INDEX IF NOT EXISTS idx_bookings_service ON bookings(service_type);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations(session_id);
    CREATE INDEX IF NOT EXISTS idx_conv_created ON conversations(created_at);
  `);

  await run(`
    CREATE OR REPLACE FUNCTION update_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await run(`DROP TRIGGER IF EXISTS bookings_updated_at ON bookings;`);
  await run(`
    CREATE TRIGGER bookings_updated_at
      BEFORE UPDATE ON bookings
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  `);

  console.log('✅ Database migration completed successfully.');
}

migrate()
  .catch((err) => {
    console.error('Database migration failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
