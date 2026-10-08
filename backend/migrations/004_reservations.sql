-- 004 — Reservations on the shared booking layer.
--
-- STATUS SEMANTICS (reservation status; operational and sync status are separate)
--   pending               A held, not-yet-confirmed reservation. Before this migration the
--                         chat created a `pending` row as soon as details were complete and
--                         that row blocked inventory. Those rows are PRESERVED and keep
--                         holding their room/table; they are listed in the review report
--                         (`legacy_pending_hold`) so staff confirm or cancel them.
--                         New conversational drafts live in chat_sessions and hold nothing.
--   confirmed / modified  Committed reservation (modified = changed after confirmation).
--   checked_in            Guest is in the room / seated / meeting in progress.
--   completed             Stay, sitting or meeting finished.
--   cancelled / no_show   Released.
--   awaiting_confirmation External provider outcome unknown; never shown as confirmed.
--   waitlisted = TRUE     Never holds inventory, whatever the status.

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
UPDATE bookings SET status = 'pending' WHERE status IS NULL;
ALTER TABLE bookings ALTER COLUMN status SET NOT NULL;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN (
  'pending', 'confirmed', 'modified', 'cancelled', 'checked_in', 'completed', 'no_show', 'awaiting_confirmation'));
ALTER TABLE bookings ALTER COLUMN waitlisted SET NOT NULL;
ALTER TABLE bookings ALTER COLUMN waitlisted SET DEFAULT FALSE;

ALTER TABLE bookings
  ADD COLUMN resource_id             BIGINT,
  ADD COLUMN resource_type_id        BIGINT,
  ADD COLUMN starts_at               TIMESTAMPTZ,
  ADD COLUMN ends_at                 TIMESTAMPTZ,
  ADD COLUMN hold_period             TSTZRANGE,       -- starts_at..ends_at widened by setup/cleaning buffers
  ADD COLUMN layout                  TEXT,
  ADD COLUMN preferred_inventory     TEXT,
  ADD COLUMN source                  TEXT NOT NULL DEFAULT 'internal' CHECK (source IN ('internal', 'external')),
  ADD COLUMN channel                 TEXT NOT NULL DEFAULT 'chat'
                                     CHECK (channel IN ('chat', 'staff', 'phone', 'walk_in', 'external', 'legacy')),
  ADD COLUMN integration_id          BIGINT,
  ADD COLUMN external_reservation_id TEXT,
  ADD COLUMN external_version        BIGINT,
  ADD COLUMN correlation_id          UUID,
  ADD COLUMN sync_status             TEXT NOT NULL DEFAULT 'not_applicable'
                                     CHECK (sync_status IN ('not_applicable', 'synced', 'pending', 'failed', 'unknown', 'attention')),
  ADD COLUMN sync_checked_at         TIMESTAMPTZ,
  ADD COLUMN attention_reason        TEXT,
  ADD COLUMN calendar_sync_status    TEXT NOT NULL DEFAULT 'none'
                                     CHECK (calendar_sync_status IN ('none', 'pending', 'synced', 'failed')),
  -- Price and policies the customer accepted, frozen at booking time.
  ADD COLUMN quote                   JSONB,
  ADD COLUMN currency                CHAR(3),
  ADD COLUMN total_amount            NUMERIC(14, 3),
  ADD COLUMN booking_fee_amount      NUMERIC(14, 3),
  ADD COLUMN min_spend_amount        NUMERIC(14, 3),
  ADD COLUMN deposit_amount          NUMERIC(14, 3),
  ADD COLUMN deposit_status          TEXT NOT NULL DEFAULT 'not_required'
                                     CHECK (deposit_status IN ('not_required', 'due', 'recorded_paid', 'waived', 'refunded')),
  ADD COLUMN deposit_recorded_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN deposit_recorded_at     TIMESTAMPTZ,
  ADD COLUMN idempotency_key         TEXT,
  ADD COLUMN created_by_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN service_started_at      TIMESTAMPTZ,
  ADD COLUMN service_ended_at        TIMESTAMPTZ,
  ADD COLUMN cancelled_at            TIMESTAMPTZ,
  ADD COLUMN cancel_reason           TEXT,
  -- Migration review: rows that could not be migrated unambiguously.
  ADD COLUMN legacy_review           BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN review_reason           TEXT;

ALTER TABLE bookings ADD CONSTRAINT bookings_business_id_key UNIQUE (business_id, id);
ALTER TABLE bookings ADD CONSTRAINT bookings_resource_fk
  FOREIGN KEY (business_id, resource_id) REFERENCES resources (business_id, id);
ALTER TABLE bookings ADD CONSTRAINT bookings_resource_type_fk
  FOREIGN KEY (business_id, resource_type_id) REFERENCES resource_types (business_id, id);
ALTER TABLE operational_events ADD CONSTRAINT operational_events_booking_fk
  FOREIGN KEY (business_id, booking_id) REFERENCES bookings (business_id, id) ON DELETE CASCADE;

-- ── Legacy backfill ────────────────────────────────────────────────────────
UPDATE bookings SET channel = 'legacy';

-- Resource: only the column that matches the booking's own service is used.
UPDATE bookings b SET resource_id = r.id, resource_type_id = r.resource_type_id
FROM resources r
WHERE r.business_id = b.business_id
  AND ((b.service_type = 'hotel'      AND r.legacy_table = 'hotel_rooms'       AND r.legacy_id = b.hotel_room_id)
    OR (b.service_type = 'restaurant' AND r.legacy_table = 'restaurant_tables' AND r.legacy_id = b.table_id)
    OR (b.service_type = 'meeting'    AND r.legacy_table = 'meeting_rooms'     AND r.legacy_id = b.meeting_room_id));

-- Times are interpreted in the legacy business timezone.
UPDATE bookings b SET
  starts_at = CASE
    WHEN b.date IS NULL THEN NULL
    WHEN b.service_type = 'hotel' THEN (b.date + TIME '14:00') AT TIME ZONE biz.timezone
    WHEN b.start_time IS NULL THEN NULL
    ELSE (b.date + b.start_time) AT TIME ZONE biz.timezone END,
  ends_at = CASE
    WHEN b.date IS NULL THEN NULL
    WHEN b.service_type = 'hotel' THEN (COALESCE(b.end_date, b.date + 1) + TIME '11:00') AT TIME ZONE biz.timezone
    WHEN b.start_time IS NULL THEN NULL
    -- The previous application treated a missing end time as one hour.
    ELSE (b.date + COALESCE(b.end_time, (b.start_time + INTERVAL '1 hour')::time)) AT TIME ZONE biz.timezone END
FROM businesses biz WHERE biz.id = b.business_id;

-- An interval that does not move forward cannot be trusted.
UPDATE bookings SET starts_at = NULL, ends_at = NULL, review_reason = 'invalid_time_range'
WHERE starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at <= starts_at;
UPDATE bookings SET review_reason = 'missing_schedule'
WHERE review_reason IS NULL AND (starts_at IS NULL OR ends_at IS NULL);

-- Only now, with untrustworthy intervals cleared, can the rule be enforced.
ALTER TABLE bookings ADD CONSTRAINT bookings_interval_check
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at);

-- Only a reservation with an actual room/table, and not on the waitlist, holds anything.
UPDATE bookings SET hold_period = tstzrange(starts_at, ends_at, '[)')
WHERE starts_at IS NOT NULL AND ends_at IS NOT NULL AND resource_id IS NOT NULL AND waitlisted = FALSE;

-- A resource column that belongs to a different service is ambiguous.
UPDATE bookings SET review_reason = 'resource_service_mismatch'
WHERE review_reason IS NULL AND resource_id IS NULL
  AND ((service_type <> 'hotel' AND hotel_room_id IS NOT NULL)
    OR (service_type <> 'restaurant' AND table_id IS NOT NULL)
    OR (service_type <> 'meeting' AND meeting_room_id IS NOT NULL));

-- Committed reservations with no room/table are reported, never auto-assigned.
UPDATE bookings SET review_reason = 'missing_resource_assignment'
WHERE review_reason IS NULL AND resource_id IS NULL AND waitlisted = FALSE
  AND status IN ('pending', 'confirmed', 'modified', 'checked_in');

-- Existing double bookings: the later row is flagged so both commitments are
-- kept and the no-double-booking constraint below can still be created.
UPDATE bookings later SET legacy_review = TRUE, review_reason = 'double_booked'
WHERE later.resource_id IS NOT NULL AND later.hold_period IS NOT NULL AND later.waitlisted = FALSE
  AND later.status IN ('pending', 'confirmed', 'modified', 'checked_in')
  AND EXISTS (
    SELECT 1 FROM bookings earlier
    WHERE earlier.id < later.id AND earlier.resource_id = later.resource_id
      AND earlier.hold_period && later.hold_period AND earlier.waitlisted = FALSE
      AND earlier.status IN ('pending', 'confirmed', 'modified', 'checked_in'));

UPDATE bookings SET review_reason = 'legacy_pending_hold'
WHERE review_reason IS NULL AND status = 'pending' AND waitlisted = FALSE;

-- Rows flagged above (other than double bookings) simply have no hold.
UPDATE bookings SET hold_period = NULL
WHERE review_reason IN ('invalid_time_range', 'missing_schedule');

-- ── The double-booking guarantee ───────────────────────────────────────────
-- One resource cannot have two overlapping inventory-holding reservations.
-- Enforced by PostgreSQL itself, so it holds under any concurrency.
ALTER TABLE bookings ADD CONSTRAINT bookings_no_double_booking
  EXCLUDE USING gist (resource_id WITH =, hold_period WITH &&)
  WHERE (source = 'internal' AND resource_id IS NOT NULL AND hold_period IS NOT NULL
         AND waitlisted = FALSE AND legacy_review = FALSE
         AND status IN ('pending', 'confirmed', 'modified', 'checked_in'));

CREATE INDEX idx_bookings_hold ON bookings USING gist (resource_id, hold_period);
CREATE INDEX idx_bookings_business_starts ON bookings (business_id, service_type, starts_at);
CREATE INDEX idx_bookings_review ON bookings (business_id) WHERE review_reason IS NOT NULL;
CREATE UNIQUE INDEX idx_bookings_external ON bookings (integration_id, external_reservation_id)
  WHERE external_reservation_id IS NOT NULL;

-- ── Idempotent booking commands ────────────────────────────────────────────
CREATE TABLE booking_commands (
  id              BIGSERIAL PRIMARY KEY,
  business_id     BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  command         TEXT NOT NULL CHECK (command IN ('create', 'modify', 'cancel')),
  service_type    TEXT NOT NULL,
  provider        TEXT NOT NULL DEFAULT 'internal',
  request_hash    TEXT NOT NULL,
  correlation_id  UUID NOT NULL,
  booking_id      INTEGER,
  status          TEXT NOT NULL DEFAULT 'in_progress'
                  CHECK (status IN ('in_progress', 'succeeded', 'failed', 'unknown')),
  result          JSONB,
  error           JSONB,
  attempts        INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, idempotency_key)
);
CREATE INDEX booking_commands_unresolved ON booking_commands (business_id, service_type)
  WHERE status IN ('in_progress', 'unknown');
CREATE TRIGGER booking_commands_updated_at BEFORE UPDATE ON booking_commands
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- The legacy business opens for booking automatically only when nothing
-- needs an owner's decision: currency is known and no committed, still
-- relevant reservation is ambiguous.
UPDATE businesses b SET status = 'active', activated_at = NOW()
WHERE b.is_legacy AND b.currency_confirmed
  AND NOT EXISTS (
    SELECT 1 FROM bookings k
    WHERE k.business_id = b.id
      AND k.review_reason IN ('missing_resource_assignment', 'resource_service_mismatch', 'double_booked',
                              'invalid_time_range', 'missing_schedule')
      AND k.status IN ('pending', 'confirmed', 'modified', 'checked_in') AND k.waitlisted = FALSE
      AND (k.ends_at IS NULL OR k.ends_at >= NOW()));
