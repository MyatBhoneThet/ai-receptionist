# Booking platform

How the multi-business booking platform is put together, how to migrate to it,
how to demonstrate it, and what is and is not finished.

## 1. Model

```
business ──< business_services (hotel | restaurant | meeting)
   │              │  enabled, booking_source = internal | external, settings (service defaults)
   │              └─ integration (only when external)
   ├──< resource_types      defaults for a kind of room/table
   │        └──< resources  one physical room/table; overrides; operational_status
   ├──< bookings            reservations (authoritative when internal, mirror when external)
   ├──< business_memberships (owner | admin | staff)
   └── customers, conversations, chat_sessions, app_settings, audit_logs,
       closures, maintenance_blocks, operational_events, integrations, sync_jobs, sync_events
```

* **One business = one physical venue.** Everything above carries `business_id`.
* **Each service has exactly one authoritative booking source** (`business_services.booking_source`).
* `resources.id` is globally unique across all three services. Nothing decides a
  resource's category from a numeric ID.

### Three separate statuses

| Status | Where | Meaning |
| --- | --- | --- |
| Reservation status | `bookings.status` (+ `waitlisted`) | `pending` held/unconfirmed · `confirmed` · `modified` · `checked_in` · `completed` · `cancelled` · `no_show` · `awaiting_confirmation` (external outcome unknown) |
| Synchronization status | `bookings.sync_status`, `calendar_sync_status` | Whether the mirror / Calendar copy is current. A sync failure never changes the reservation status. |
| Operational status | `resources.operational_status` | `ready` · `in_use` · `needs_cleaning` · `out_of_service` — the real-world state of the room or table |

### Pending bookings before and after

Before the platform, the chat inserted a `pending` row as soon as a request was
complete, and that row blocked inventory until someone confirmed or abandoned it.

Now a conversational draft lives in `chat_sessions` and **holds nothing**;
availability is re-checked, under lock, when the customer confirms.

Existing `pending` rows are **kept** and **keep holding** their room or table.
They appear in the review report as `legacy_pending_hold` so staff confirm or
cancel each one. `pending` is still used for holds staff create on purpose.

## 2. Configuration inheritance

`platform default → service settings → resource-type defaults → resource overrides`

Each level stores only what it sets. The API returns `effective.values` and
`effective.sources` so the dashboard can show "inherited" and offer *Reset to
default* (which deletes that level's value).

| Service | Fields |
| --- | --- |
| Hotel rooms | Maximum guests, bed configuration, amenities, base nightly rate, check-in/out times, minimum stay, floor, deposit, booking fee |
| Meeting rooms | Capacity by layout, equipment, amenities, hourly/daily rate, minimum duration, increments, setup/cleanup buffers, operating hours, deposit, booking fee |
| Restaurant tables | Seating capacity, seating area, default duration, turnover buffer, minimum spend, deposit, booking fee, operating hours |

**Money.** Amounts are exact decimal strings with the business currency, computed
in integer minor units. *Minimum spend* (a spending commitment), *deposit* (due in
advance) and *booking fee* (part of the charged total) are three separate values.
Deposits are disclosed and staff record their status. No payment is taken or
claimed to have been taken.

The accepted quote (prices and policies) is stored on the reservation, so later
setting changes do not alter existing commitments. A change that would leave an
upcoming reservation over a new capacity, or deactivate its room, is refused
until the user explicitly acknowledges the affected reservations.

## 3. The shared booking layer

`backend/booking/service.js` is the only entry point for booking operations.
AI chat, staff actions, walk-ins, admin edits and waitlist promotion all call it.

```
checkAvailability · createReservation · modifyReservation · cancelReservation
getReservation · applyOperation · addMaintenance · promoteWaitlist · findAlternatives
```

It picks the provider from the service's booking source:

* `providers/internal.js` — our database is authoritative.
* `external.js` + a connector from `providers/index.js` — the connected system is authoritative.

Errors are `BookingError` with a `code`: `validation`, `conflict`,
`quote_changed`, `not_ready`, `unsupported_operation`, `provider_error`,
`provider_unavailable`, `idempotency_conflict`, `not_found`.

### Internal mode guarantees

* Availability is computed for the requested interval (reservations, maintenance
  blocks, capacity, operating hours incl. overnight periods, closures, minimum
  stay/duration, increments, setup/cleaning/turnover buffers).
* The final check and the write run in **one transaction on one connection**
  with the service's resource rows locked.
* PostgreSQL enforces `bookings_no_double_booking`, an exclusion constraint on
  `(resource_id, hold_period)`. It holds even if application code is bypassed.
* Booking commands require an idempotency key; a retry or double-click returns
  the original reservation.
* A failed modification rolls back and leaves the original untouched.
* Hotel stays keep check-in/check-out as property-local dates. A stay ends at
  check-out time, so the next stay can begin that day.
* Cleaning or current occupancy affects only immediate use (walk-in, check-in),
  never future dates.
* Waitlist entries hold nothing. Promotion re-evaluates the full request
  (party size, dates, duration, type) through the same engine.

### External mode guarantees

* Availability is asked of the provider on every check; nothing is served from cache.
* The command is committed locally *before* the provider is called.
* A reservation is `confirmed` only after the provider acknowledges it.
* Provider down → structured `provider_unavailable`. There is no fallback to an
  internal booking.
* Timeout after submit → the request is looked up by our correlation ID. If the
  outcome is still unknown the local row is `awaiting_confirmation` and a durable
  job keeps checking. It is never resubmitted automatically; if the provider has
  no record, staff are asked to step in.
* Inbound events (webhook or reconciliation) are de-duplicated by event ID and
  ordered by version, so replays and late events are harmless.
* A physical room is recorded only when the provider assigns one that is mapped.
* Unsupported operations are refused with a message directing staff to the source system.
* The booking source cannot be switched while active/upcoming reservations or
  unresolved provider commands exist. Switching later needs a controlled migration.

### Google Calendar

Calendar is a downstream display. Booking changes enqueue a durable
`calendar_sync` job (tried once inline). A Calendar outage cannot undo a
reservation, a deleted Calendar event cannot cancel one, and retries only touch
the Calendar event. The old "import Calendar deletions as cancellations" mode
has been removed.

## 4. Access control

* Staff routes live under `/api/b/:businessId/…`. The server looks up the signed-in
  user's membership of that business; a business ID in a URL or body grants nothing.
  Non-members receive 404.
* Owners/admins manage configuration, integrations and access. Staff manage
  reservations and daily operations.
* Guest session tokens are an HMAC over `(business, session)`. A session or
  booking ID from another business finds nothing.
* `ALLOW_PUBLIC_ADMIN_ACCESS` and the static `X-Admin-Token` are gone.

## 5. Migrating an existing database

Migrations are versioned SQL files in `backend/migrations/`, applied in order,
each in its own transaction, tracked in `schema_migrations`. They are additive.
**`db/schema.sql` drops every table and must never be run on real data.**

1. Back up, or better, rehearse on a copy (for Neon: a branch).
2. Set the legacy identity. The timezone is required because existing dates and
   times were stored without one:
   ```bash
   cd backend
   LEGACY_BUSINESS_TIMEZONE=Asia/Bangkok LEGACY_BUSINESS_CURRENCY=THB \
   LEGACY_BUSINESS_NAME="Your venue" LEGACY_BUSINESS_SLUG=your-venue npm run db:migrate
   ```
   Leave `LEGACY_BUSINESS_CURRENCY` unset if you are not certain; an owner then
   confirms it in Settings before activation.
3. Read the review report it prints (`npm run db:review` prints it again).
4. Sign in as the existing admin (now the legacy business's owner), open
   **Setup**, resolve the listed reservations, and activate.
   If no admin account existed: `npm run business:grant -- --email you@example.com --business your-venue --role owner`.

What the migration does with existing data:

* Creates one legacy business and assigns every existing row to it.
* Existing `admin`/`staff` users become members of that business only. The
  earliest admin becomes owner. Customer accounts get no business access.
* `hotel_rooms`, `restaurant_tables`, `meeting_rooms` → `resource_types` +
  `resources`, keeping `(legacy_table, legacy_id)`. The old tables are left in place.
* Each booking's resource comes only from the column matching its own service.
* Review reasons, never guessed: `missing_resource_assignment`,
  `resource_service_mismatch`, `double_booked`, `invalid_time_range`,
  `missing_schedule`, `legacy_pending_hold`. All but the last block activation
  of that service while the reservation is active and not yet past.
* The legacy business is activated automatically only if the currency was
  supplied and nothing blocks.

## 6. Demonstrations

```bash
createdb ai_receptionist_dev
cd backend
DATABASE_URL=postgres://localhost:5432/ai_receptionist_dev npm run db:migrate
DATABASE_URL=postgres://localhost:5432/ai_receptionist_dev \
  npm run demo:seed -- --email you@example.com --password "choose-a-password"
```

This creates *Demo Grand Hotel* (`demo-hotel`): restaurant tables and meeting
rooms managed internally, hotel rooms sourced from the mock provider. Start the
backend with that `DATABASE_URL` and `ALLOW_MOCK_PROVIDER_BOOKING=true`.

**Internal mode**
1. *Inventory → Restaurant tables → Add tables*: preview generated codes; existing codes are flagged; the batch saves all or nothing.
2. Edit `P02`: override minimum spend, see "Set here" vs "Inherited", then *Reset to default*.
3. Guest chat (`/?business=demo-hotel`): ask for a private table for six. The reply quotes minimum spend and deposit from the backend; confirm.
4. *Operations*: seat a walk-in, finish the sitting (table becomes "needs cleaning"), mark ready, add a maintenance block.
5. Open the same slot in two tabs and confirm both: one succeeds, the other is told the table was taken and offered an alternative or the waitlist.

**Mock external mode**
1. *Integrations*: the connection is labelled MOCK; view capabilities, mappings and history.
2. *Reservations → New reservation → Hotel rooms*: availability is "checked live"; only a room type is offered.
3. Mock controls → *Assign a room in the PMS*, then *Reconcile now*: the reservation gains its room.
4. *Simulate outage*, then try to book: the provider is reported unavailable and nothing is created.
5. *Next booking: accept, then time out*, then book: the reservation shows "Awaiting confirmation" until *Run pending jobs now* settles it — with one reservation in the mock, not two.
6. *Cancel in the PMS*, then *Reconcile now*: the local mirror becomes cancelled.

## 7. Tests

```bash
cd backend && npm test          # needs a local PostgreSQL; uses ai_receptionist_test
cd frontend && npm run test:voice && npm run build
```

Tests refuse to run unless the database name contains `test`, and never use the
`DATABASE_URL` from `.env`. The language model, Google Calendar and outbound
notifications are mocked; the database is real.

## 8. Known limitations

* **No production PMS connector.** Only the mock exists. See §9.
* Mock coverage is hotel (room-type inventory). Restaurant and meeting are declared unsupported by the mock.
* Deposits are recorded by staff; there is no payment gateway.
* Out of scope for this version: subscription billing, dynamic hotel pricing,
  automatic table combinations, multi-room/group reservations, multi-property businesses.
* Changing the booking source after go-live needs a controlled migration that does not exist yet.
* One reservation occupies one resource. A party larger than every table is refused, not split.
* Webhooks are processed synchronously on receipt and are durable from that point;
  missed deliveries are covered by scheduled reconciliation.
* The job worker runs inside the API process. Several API instances are safe
  (jobs are claimed with `SKIP LOCKED`), but there is no separate worker process.
* Chat state for one session assumes one request at a time.
* Google Calendar uses one deployment-wide service account; each business supplies its own calendar ID.
* The dashboard was checked by hand in a desktop browser; there are no automated browser tests.

## 9. What is needed for the first real PMS connector

Implement the interface documented at the top of `backend/booking/providers/index.js`
and register it there. Before that can be written, the following must be known:

1. **Vendor and product** (name, edition, cloud/on-premise, API version) and which
   of hotel / restaurant / meeting it manages.
2. **Official API documentation** and a **sandbox** account. No endpoints will be guessed.
3. **Authentication**: scheme (OAuth2 client credentials, API key, signed requests…),
   how credentials are issued and rotated, token lifetime, IP allow-listing.
4. **Commercial/approval requirements**: partner programme, certification, per-property activation.
5. **Inventory model**: does it sell room types with later room assignment, or
   physical rooms? How are rate plans, occupancy and restrictions represented?
6. **Availability and pricing**: the endpoint that is authoritative for a date
   range, and how taxes, fees and currency are returned.
7. **Reservation lifecycle**: create / read / modify / cancel endpoints, the
   status vocabulary, which fields are mutable.
8. **Idempotency and lookup**: does create accept an idempotency key or a client
   reference, and can a reservation be found by that reference after a timeout?
9. **Change notification**: webhooks (events, signature scheme, retry policy,
   ordering guarantees) and/or a changes-since endpoint with a cursor.
10. **Operational updates**: can check-in, check-out, room status or
    out-of-order periods be written through the API?
11. **Limits**: rate limits, pagination, maintenance windows, timeouts.
12. **Identifiers and mapping**: stable IDs for properties, room types and rooms.
13. **Data handling**: which guest fields may be sent or stored, and retention rules.
