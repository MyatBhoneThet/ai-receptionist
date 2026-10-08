-- 002 — Business accounts and data separation.
-- Existing single-tenant rows are assigned to one "legacy" business. The
-- runner supplies its identity through session settings:
--   app.legacy_timezone (required when legacy data exists)
--   app.legacy_currency (optional; left unconfirmed when absent)
--   app.legacy_name / app.legacy_slug (optional)

CREATE TABLE businesses (
  id                 BIGSERIAL PRIMARY KEY,
  name               TEXT NOT NULL CHECK (length(trim(name)) > 0),
  slug               TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  timezone           TEXT NOT NULL,
  currency           CHAR(3) CHECK (currency ~ '^[A-Z]{3}$'),
  currency_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  contact_email      TEXT,
  contact_phone      TEXT,
  address            TEXT,
  status             TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'active', 'paused')),
  is_legacy          BOOLEAN NOT NULL DEFAULT FALSE,
  activated_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (NOT currency_confirmed OR currency IS NOT NULL)
);
CREATE UNIQUE INDEX businesses_single_legacy ON businesses (is_legacy) WHERE is_legacy;
CREATE TRIGGER businesses_updated_at BEFORE UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE business_memberships (
  id          BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'staff')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, user_id)
);
CREATE INDEX business_memberships_user ON business_memberships (user_id);

-- Exactly one authoritative booking source per (business, service).
CREATE TABLE business_services (
  id             BIGSERIAL PRIMARY KEY,
  business_id    BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_type   TEXT NOT NULL CHECK (service_type IN ('hotel', 'restaurant', 'meeting')),
  enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  booking_source TEXT NOT NULL DEFAULT 'internal' CHECK (booking_source IN ('internal', 'external')),
  integration_id BIGINT,
  settings       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, service_type),
  CHECK (booking_source = 'external' OR integration_id IS NULL)
);
CREATE TRIGGER business_services_updated_at BEFORE UPDATE ON business_services
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Legacy business ────────────────────────────────────────────────────────
DO $$
DECLARE
  has_legacy BOOLEAN;
  tz TEXT := NULLIF(current_setting('app.legacy_timezone', true), '');
  cur TEXT := upper(NULLIF(current_setting('app.legacy_currency', true), ''));
  legacy_name TEXT := COALESCE(NULLIF(current_setting('app.legacy_name', true), ''), 'Legacy business');
  legacy_slug TEXT := COALESCE(NULLIF(current_setting('app.legacy_slug', true), ''), 'legacy');
BEGIN
  SELECT EXISTS (SELECT 1 FROM bookings) OR EXISTS (SELECT 1 FROM customers)
      OR EXISTS (SELECT 1 FROM hotel_rooms) OR EXISTS (SELECT 1 FROM restaurant_tables)
      OR EXISTS (SELECT 1 FROM meeting_rooms) OR EXISTS (SELECT 1 FROM conversations)
      OR EXISTS (SELECT 1 FROM app_settings) OR EXISTS (SELECT 1 FROM audit_logs)
      OR EXISTS (SELECT 1 FROM users WHERE role IN ('admin', 'staff'))
    INTO has_legacy;
  IF NOT has_legacy THEN RETURN; END IF;

  IF tz IS NULL THEN
    RAISE EXCEPTION 'Existing data found: set LEGACY_BUSINESS_TIMEZONE (an IANA zone such as Asia/Bangkok) so existing dates and times are interpreted correctly.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = tz) THEN
    RAISE EXCEPTION 'LEGACY_BUSINESS_TIMEZONE "%" is not a known IANA timezone.', tz;
  END IF;
  IF cur IS NOT NULL AND cur !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'LEGACY_BUSINESS_CURRENCY "%" must be a 3-letter ISO 4217 code.', cur;
  END IF;

  INSERT INTO businesses (name, slug, timezone, currency, currency_confirmed, status, is_legacy)
  VALUES (legacy_name, legacy_slug, tz, cur, cur IS NOT NULL, 'setup', TRUE);
END;
$$;

-- Existing staff keep access to the legacy business only. The earliest admin
-- becomes its owner. Customer accounts receive no business access.
INSERT INTO business_memberships (business_id, user_id, role)
SELECT b.id, u.id,
       CASE WHEN u.role = 'staff' THEN 'staff'
            WHEN u.id = (SELECT MIN(id) FROM users WHERE role = 'admin') THEN 'owner'
            ELSE 'admin' END
FROM users u CROSS JOIN businesses b
WHERE b.is_legacy AND u.role IN ('admin', 'staff');

INSERT INTO business_services (business_id, service_type, enabled, booking_source)
SELECT b.id, s.service_type,
       CASE s.service_type
         WHEN 'hotel'      THEN EXISTS (SELECT 1 FROM hotel_rooms)       OR EXISTS (SELECT 1 FROM bookings WHERE service_type = 'hotel')
         WHEN 'restaurant' THEN EXISTS (SELECT 1 FROM restaurant_tables) OR EXISTS (SELECT 1 FROM bookings WHERE service_type = 'restaurant')
         ELSE                   EXISTS (SELECT 1 FROM meeting_rooms)     OR EXISTS (SELECT 1 FROM bookings WHERE service_type = 'meeting')
       END,
       'internal'
FROM businesses b CROSS JOIN (VALUES ('hotel'), ('restaurant'), ('meeting')) AS s(service_type)
WHERE b.is_legacy;

-- ── business_id on existing tables ─────────────────────────────────────────
ALTER TABLE customers     ADD COLUMN business_id BIGINT REFERENCES businesses(id);
ALTER TABLE bookings      ADD COLUMN business_id BIGINT REFERENCES businesses(id);
ALTER TABLE conversations ADD COLUMN business_id BIGINT REFERENCES businesses(id);
ALTER TABLE app_settings  ADD COLUMN business_id BIGINT REFERENCES businesses(id);
ALTER TABLE audit_logs    ADD COLUMN business_id BIGINT REFERENCES businesses(id);
ALTER TABLE audit_logs    ADD COLUMN actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE audit_logs    ALTER COLUMN entity_id TYPE BIGINT;

UPDATE customers     SET business_id = (SELECT id FROM businesses WHERE is_legacy);
UPDATE bookings      SET business_id = (SELECT id FROM businesses WHERE is_legacy);
UPDATE conversations SET business_id = (SELECT id FROM businesses WHERE is_legacy);
UPDATE app_settings  SET business_id = (SELECT id FROM businesses WHERE is_legacy);
UPDATE audit_logs    SET business_id = (SELECT id FROM businesses WHERE is_legacy);

ALTER TABLE customers     ALTER COLUMN business_id SET NOT NULL;
ALTER TABLE bookings      ALTER COLUMN business_id SET NOT NULL;
ALTER TABLE conversations ALTER COLUMN business_id SET NOT NULL;
ALTER TABLE app_settings  ALTER COLUMN business_id SET NOT NULL;
-- audit_logs.business_id stays nullable for platform-level events.

-- A phone number identifies a customer within one business, not globally.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'customers'::regclass AND con.contype = 'u'
      AND (SELECT array_agg(a.attname::text) FROM pg_attribute a
           WHERE a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)) = ARRAY['phone_number']
  LOOP
    EXECUTE format('ALTER TABLE customers DROP CONSTRAINT %I', c.conname);
  END LOOP;
END;
$$;
ALTER TABLE customers ADD CONSTRAINT customers_business_phone_key UNIQUE (business_id, phone_number);
ALTER TABLE customers ADD CONSTRAINT customers_business_id_key UNIQUE (business_id, id);

ALTER TABLE app_settings DROP CONSTRAINT app_settings_pkey;
ALTER TABLE app_settings ADD PRIMARY KEY (business_id, key);

CREATE INDEX idx_bookings_business      ON bookings (business_id, service_type, date);
CREATE INDEX idx_bookings_business_sess ON bookings (business_id, session_id);
CREATE INDEX idx_conv_business_session  ON conversations (business_id, session_id, created_at);
CREATE INDEX idx_audit_business         ON audit_logs (business_id, created_at DESC);

-- Guest chat state, scoped to a business (previously an in-process Map).
CREATE TABLE chat_sessions (
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  state       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, session_id)
);
