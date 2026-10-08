-- 003 — Configurable inventory: service settings → resource types → physical
-- resources. `resources.id` is globally unique across all three services, so
-- a resource is never identified by guessing a category from a numeric ID.
-- Legacy rows keep their original identifier in (legacy_table, legacy_id).

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE resource_types (
  id           BIGSERIAL PRIMARY KEY,
  business_id  BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_type TEXT NOT NULL CHECK (service_type IN ('hotel', 'restaurant', 'meeting')),
  name         TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description  TEXT NOT NULL DEFAULT '',
  code_prefix  TEXT NOT NULL DEFAULT '',
  defaults     JSONB NOT NULL DEFAULT '{}'::jsonb,
  managed_by   TEXT NOT NULL DEFAULT 'internal' CHECK (managed_by IN ('internal', 'external')),
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, service_type, id)
);
CREATE UNIQUE INDEX resource_types_name_key
  ON resource_types (business_id, service_type, lower(name)) WHERE archived_at IS NULL;
CREATE TRIGGER resource_types_updated_at BEFORE UPDATE ON resource_types
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE resources (
  id                     BIGSERIAL PRIMARY KEY,
  business_id            BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_type           TEXT NOT NULL CHECK (service_type IN ('hotel', 'restaurant', 'meeting')),
  resource_type_id       BIGINT NOT NULL,
  code                   TEXT NOT NULL CHECK (length(trim(code)) > 0),
  name                   TEXT NOT NULL DEFAULT '',
  overrides              JSONB NOT NULL DEFAULT '{}'::jsonb,
  managed_by             TEXT NOT NULL DEFAULT 'internal' CHECK (managed_by IN ('internal', 'external')),
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  archived_at            TIMESTAMPTZ,
  -- Real-world state, deliberately separate from any reservation's status.
  operational_status     TEXT NOT NULL DEFAULT 'ready'
                         CHECK (operational_status IN ('ready', 'in_use', 'needs_cleaning', 'out_of_service')),
  operational_note       TEXT NOT NULL DEFAULT '',
  operational_updated_at TIMESTAMPTZ,
  operational_updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  legacy_table           TEXT,
  legacy_id              INTEGER,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, service_type, resource_type_id)
    REFERENCES resource_types (business_id, service_type, id)
);
-- The same code may exist in other businesses, but not twice in one service.
CREATE UNIQUE INDEX resources_code_key
  ON resources (business_id, service_type, lower(code)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX resources_legacy_key ON resources (legacy_table, legacy_id) WHERE legacy_table IS NOT NULL;
CREATE INDEX resources_type ON resources (resource_type_id);
CREATE TRIGGER resources_updated_at BEFORE UPDATE ON resources
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE closures (
  id           BIGSERIAL PRIMARY KEY,
  business_id  BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_type TEXT CHECK (service_type IN ('hotel', 'restaurant', 'meeting')),  -- NULL = whole business
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,   -- inclusive, business-local
  reason       TEXT NOT NULL DEFAULT '',
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date)
);
CREATE INDEX closures_business ON closures (business_id, start_date, end_date);

CREATE TABLE maintenance_blocks (
  id          BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL,
  resource_id BIGINT NOT NULL,
  period      TSTZRANGE NOT NULL CHECK (NOT isempty(period) AND NOT lower_inf(period) AND NOT upper_inf(period)),
  reason      TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at  TIMESTAMPTZ,
  removed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (business_id, resource_id) REFERENCES resources (business_id, id) ON DELETE CASCADE
);
CREATE INDEX maintenance_blocks_active ON maintenance_blocks USING gist (resource_id, period) WHERE removed_at IS NULL;

-- Who changed a resource's real-world state, and when.
CREATE TABLE operational_events (
  id            BIGSERIAL PRIMARY KEY,
  business_id   BIGINT NOT NULL,
  resource_id   BIGINT,
  booking_id    INTEGER,
  action        TEXT NOT NULL,
  from_status   TEXT,
  to_status     TEXT,
  note          TEXT NOT NULL DEFAULT '',
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_label   TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (business_id, resource_id) REFERENCES resources (business_id, id) ON DELETE CASCADE
);
CREATE INDEX operational_events_resource ON operational_events (business_id, resource_id, created_at DESC);

-- ── Legacy inventory backfill ──────────────────────────────────────────────
-- Legacy behaviour is written down as explicit service settings so later
-- platform-default changes cannot alter how existing bookings were sold.
UPDATE business_services bs SET settings = CASE bs.service_type
    WHEN 'hotel'      THEN '{"check_in_time":"14:00","check_out_time":"11:00","min_stay_nights":1}'::jsonb
    WHEN 'restaurant' THEN '{"default_duration_minutes":60,"turnover_buffer_minutes":0}'::jsonb
    ELSE                   '{"min_duration_minutes":30,"increment_minutes":15,"setup_buffer_minutes":0,"cleanup_buffer_minutes":0,"rate_unit":"hourly"}'::jsonb
  END
FROM businesses b WHERE b.id = bs.business_id AND b.is_legacy;

CREATE FUNCTION pg_temp.legacy_tags(doc JSONB) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN doc IS NULL THEN '[]'::jsonb
    WHEN jsonb_typeof(doc) = 'array' THEN doc
    WHEN jsonb_typeof(doc) = 'object' THEN COALESCE(
      (SELECT jsonb_agg(key ORDER BY key) FROM jsonb_each(doc) WHERE value = 'true'::jsonb), '[]'::jsonb)
    ELSE '[]'::jsonb END
$$;

-- Hotel: one type per legacy room_type; the lowest-id room supplies the type
-- defaults and rooms that differ keep the difference as an individual override.
WITH legacy AS (SELECT id FROM businesses WHERE is_legacy),
tmpl AS (
  SELECT DISTINCT ON (lower(trim(room_type))) trim(room_type) AS name, capacity, price_per_night, amenities
  FROM hotel_rooms ORDER BY lower(trim(room_type)), id
)
INSERT INTO resource_types (business_id, service_type, name, defaults)
SELECT legacy.id, 'hotel', tmpl.name,
       jsonb_strip_nulls(jsonb_build_object(
         'max_guests', COALESCE(tmpl.capacity, 2),
         'base_rate', CASE WHEN tmpl.price_per_night IS NOT NULL THEN to_jsonb(tmpl.price_per_night::text) END,
         'amenities', pg_temp.legacy_tags(tmpl.amenities)))
FROM tmpl CROSS JOIN legacy;

INSERT INTO resources (business_id, service_type, resource_type_id, code, name, overrides, is_active, legacy_table, legacy_id)
SELECT rt.business_id, 'hotel', rt.id, hr.room_number, '',
       jsonb_strip_nulls(jsonb_build_object(
         'floor', hr.floor,
         'max_guests', CASE WHEN COALESCE(hr.capacity, 2) <> (rt.defaults->>'max_guests')::int THEN COALESCE(hr.capacity, 2) END,
         'base_rate', CASE WHEN hr.price_per_night IS NOT NULL
                            AND hr.price_per_night::text IS DISTINCT FROM (rt.defaults->>'base_rate')
                           THEN to_jsonb(hr.price_per_night::text) END,
         'amenities', CASE WHEN pg_temp.legacy_tags(hr.amenities) <> COALESCE(rt.defaults->'amenities', '[]'::jsonb)
                           THEN pg_temp.legacy_tags(hr.amenities) END)),
       COALESCE(hr.is_active, TRUE), 'hotel_rooms', hr.id
FROM hotel_rooms hr
JOIN resource_types rt ON rt.service_type = 'hotel' AND lower(rt.name) = lower(trim(hr.room_type))
JOIN businesses b ON b.id = rt.business_id AND b.is_legacy;

-- Restaurant: legacy tables had only a location, which becomes the table type.
WITH legacy AS (SELECT id FROM businesses WHERE is_legacy),
tmpl AS (
  SELECT DISTINCT ON (lower(trim(COALESCE(location, 'indoor')))) lower(trim(COALESCE(location, 'indoor'))) AS area, capacity
  FROM restaurant_tables ORDER BY lower(trim(COALESCE(location, 'indoor'))), id
)
INSERT INTO resource_types (business_id, service_type, name, defaults)
SELECT legacy.id, 'restaurant', initcap(tmpl.area) || ' table',
       jsonb_build_object('seating_capacity', COALESCE(tmpl.capacity, 4), 'seating_area', tmpl.area)
FROM tmpl CROSS JOIN legacy;

INSERT INTO resources (business_id, service_type, resource_type_id, code, name, overrides, is_active, legacy_table, legacy_id)
SELECT rt.business_id, 'restaurant', rt.id, t.table_number, '',
       jsonb_strip_nulls(jsonb_build_object(
         'seating_capacity', CASE WHEN COALESCE(t.capacity, 4) <> (rt.defaults->>'seating_capacity')::int THEN COALESCE(t.capacity, 4) END)),
       COALESCE(t.is_active, TRUE), 'restaurant_tables', t.id
FROM restaurant_tables t
JOIN resource_types rt ON rt.service_type = 'restaurant'
     AND rt.defaults->>'seating_area' = lower(trim(COALESCE(t.location, 'indoor')))
JOIN businesses b ON b.id = rt.business_id AND b.is_legacy;

-- Meeting: legacy rooms had no type; they share one type and each room keeps
-- its own capacity and equipment as overrides.
INSERT INTO resource_types (business_id, service_type, name, defaults)
SELECT b.id, 'meeting', 'Meeting room', '{"layouts":[{"name":"Standard","capacity":10}],"equipment":[]}'::jsonb
FROM businesses b WHERE b.is_legacy AND EXISTS (SELECT 1 FROM meeting_rooms);

INSERT INTO resources (business_id, service_type, resource_type_id, code, name, overrides, is_active, legacy_table, legacy_id)
SELECT rt.business_id, 'meeting', rt.id, m.room_code, m.room_name,
       jsonb_build_object(
         'layouts', jsonb_build_array(jsonb_build_object('name', 'Standard', 'capacity', COALESCE(m.capacity, 10))),
         'equipment', pg_temp.legacy_tags(m.equipment)),
       COALESCE(m.is_active, TRUE), 'meeting_rooms', m.id
FROM meeting_rooms m
JOIN resource_types rt ON rt.service_type = 'meeting'
JOIN businesses b ON b.id = rt.business_id AND b.is_legacy;
