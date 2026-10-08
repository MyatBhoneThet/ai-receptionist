-- 005 — External provider foundation, durable synchronization, and the mock
-- provider's own authoritative store.

CREATE TABLE integrations (
  id                 BIGSERIAL PRIMARY KEY,
  business_id        BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider_key       TEXT NOT NULL,
  name               TEXT NOT NULL,
  -- 'mock' is a development double. 'production' rows cannot be created until
  -- a real connector is registered in code.
  environment        TEXT NOT NULL DEFAULT 'mock' CHECK (environment IN ('mock', 'sandbox', 'production')),
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'connected', 'error', 'disabled')),
  config             JSONB NOT NULL DEFAULT '{}'::jsonb,   -- non-secret settings only
  credentials_enc    TEXT,                                 -- AES-256-GCM, never returned to clients
  webhook_secret_enc TEXT,
  capabilities       JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_cursor        TEXT,
  last_tested_at     TIMESTAMPTZ,
  last_test_result   JSONB,
  last_reconciled_at TIMESTAMPTZ,
  last_error         TEXT,
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, id)
);
CREATE TRIGGER integrations_updated_at BEFORE UPDATE ON integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE business_services ADD CONSTRAINT business_services_integration_fk
  FOREIGN KEY (business_id, integration_id) REFERENCES integrations (business_id, id);
ALTER TABLE bookings ADD CONSTRAINT bookings_integration_fk
  FOREIGN KEY (business_id, integration_id) REFERENCES integrations (business_id, id);

CREATE TABLE external_mappings (
  id               BIGSERIAL PRIMARY KEY,
  business_id      BIGINT NOT NULL,
  integration_id   BIGINT NOT NULL,
  service_type     TEXT NOT NULL CHECK (service_type IN ('hotel', 'restaurant', 'meeting')),
  kind             TEXT NOT NULL CHECK (kind IN ('resource_type', 'resource')),
  external_id      TEXT NOT NULL,
  external_name    TEXT NOT NULL DEFAULT '',
  external_data    JSONB NOT NULL DEFAULT '{}'::jsonb,     -- provider-owned, read-only locally
  resource_type_id BIGINT,
  resource_id      BIGINT,
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (integration_id, kind, external_id),
  FOREIGN KEY (business_id, integration_id) REFERENCES integrations (business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, resource_type_id) REFERENCES resource_types (business_id, id),
  FOREIGN KEY (business_id, resource_id) REFERENCES resources (business_id, id)
);

-- Durable background work: survives restarts, retried with backoff.
CREATE TABLE sync_jobs (
  id             BIGSERIAL PRIMARY KEY,
  business_id    BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  integration_id BIGINT,
  kind           TEXT NOT NULL,
  dedupe_key     TEXT NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 8,
  run_after      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at      TIMESTAMPTZ,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ
);
-- At most one live job per piece of work, so retries never fan out.
CREATE UNIQUE INDEX sync_jobs_live_key ON sync_jobs (business_id, kind, dedupe_key) WHERE status IN ('queued', 'running');
CREATE INDEX sync_jobs_due ON sync_jobs (run_after) WHERE status = 'queued';
CREATE TRIGGER sync_jobs_updated_at BEFORE UPDATE ON sync_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Synchronization history; also the de-duplication record for inbound events.
CREATE TABLE sync_events (
  id                      BIGSERIAL PRIMARY KEY,
  business_id             BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  integration_id          BIGINT,
  direction               TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  event_type              TEXT NOT NULL,
  external_event_id       TEXT,
  external_reservation_id TEXT,
  external_version        BIGINT,
  booking_id              INTEGER,
  outcome                 TEXT NOT NULL CHECK (outcome IN ('applied', 'duplicate', 'stale', 'ignored', 'failed', 'unknown')),
  detail                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX sync_events_inbound_key ON sync_events (integration_id, external_event_id)
  WHERE direction = 'inbound' AND external_event_id IS NOT NULL AND outcome IN ('applied', 'stale', 'ignored');
CREATE INDEX sync_events_recent ON sync_events (business_id, created_at DESC);

-- ── Mock PMS ───────────────────────────────────────────────────────────────
-- These tables stand in for a REMOTE system. Application code reaches them
-- only through the mock connector; local reservations are mirrored in
-- `bookings`. Keeping them apart lets tests change the "remote" side directly.
CREATE TABLE mock_pms_accounts (
  integration_id BIGINT PRIMARY KEY REFERENCES integrations(id) ON DELETE CASCADE,
  settings       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- capabilities + injected faults
  next_version   BIGINT NOT NULL DEFAULT 1
);
CREATE TABLE mock_pms_room_types (
  id             BIGSERIAL PRIMARY KEY,
  integration_id BIGINT NOT NULL REFERENCES mock_pms_accounts(integration_id) ON DELETE CASCADE,
  service_type   TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  name           TEXT NOT NULL,
  capacity       INTEGER NOT NULL,
  rate           NUMERIC(14, 3) NOT NULL DEFAULT 0,
  units          INTEGER NOT NULL DEFAULT 1,           -- sellable count for type-level inventory
  UNIQUE (integration_id, external_id)
);
CREATE TABLE mock_pms_units (
  id             BIGSERIAL PRIMARY KEY,
  integration_id BIGINT NOT NULL REFERENCES mock_pms_accounts(integration_id) ON DELETE CASCADE,
  type_external_id TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  code           TEXT NOT NULL,
  UNIQUE (integration_id, external_id)
);
CREATE TABLE mock_pms_reservations (
  id               BIGSERIAL PRIMARY KEY,
  integration_id   BIGINT NOT NULL REFERENCES mock_pms_accounts(integration_id) ON DELETE CASCADE,
  external_id      TEXT NOT NULL,
  correlation_id   TEXT,
  idempotency_key  TEXT,
  service_type     TEXT NOT NULL,
  type_external_id TEXT NOT NULL,
  unit_external_id TEXT,
  status           TEXT NOT NULL,
  guest_name       TEXT,
  party_size       INTEGER,
  starts_at        TIMESTAMPTZ NOT NULL,
  ends_at          TIMESTAMPTZ NOT NULL,
  total            NUMERIC(14, 3),
  version          BIGINT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (integration_id, external_id)
);
CREATE TABLE mock_pms_events (
  id             BIGSERIAL PRIMARY KEY,
  integration_id BIGINT NOT NULL REFERENCES mock_pms_accounts(integration_id) ON DELETE CASCADE,
  event_id       TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  reservation_external_id TEXT NOT NULL,
  version        BIGINT NOT NULL,
  payload        JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (integration_id, event_id)
);
