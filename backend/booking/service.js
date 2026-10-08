// ─────────────────────────────────────────────────────────────────────────────
// The shared booking application layer.
//
// AI chat, staff actions, walk-ins, admin updates and waitlist promotion all go
// through these functions. The provider is chosen from the business + service
// configuration; callers never write to `bookings` themselves.
//
// Every function returns the same structures for both providers:
//   availability → { service_type, source, freshness, available, selected, options, reason, ... }
//   mutation     → { reservation, calendar_sync, idempotent_replay?, promoted? }
// and fails with a BookingError whose code is one of: validation, conflict,
// quote_changed, not_ready, unsupported_operation, provider_error,
// provider_unavailable, idempotency_conflict, not_found.
// ─────────────────────────────────────────────────────────────────────────────
import { query } from '../services/db.js';
import { BookingError, notFound, validationError } from '../platform/errors.js';
import { getService, HOLDING_STATUSES } from '../platform/businesses.js';
import { recordAudit } from '../platform/audit.js';
import { addDays, parseTime, formatMinutes, toDateKey, displayDate } from '../platform/time.js';
import { availabilitySchema, createSchema, modifySchema, modifyOptionsSchema } from './schemas.js';
import { internalProvider } from './providers/internal.js';
import { externalBooking } from './external.js';
import { internalOperations, operationSchema, operationsBoard, RESOURCE_ACTIONS } from './operations.js';
import { fetchReservation, listReservations } from './reservations.js';
import { afterChange } from './downstream.js';
import { registerJobHandler } from './sync/jobs.js';

async function providerFor(business, serviceType) {
  const service = await getService(business.id, serviceType);
  if (!service || !service.enabled) {
    throw validationError(`${serviceType} bookings are not offered by this business.`, { reason: 'service_not_enabled' });
  }
  // Exactly one authoritative source per service. There is no fallback.
  return service.booking_source === 'external' ? { mode: 'external', provider: externalBooking } : { mode: 'internal', provider: internalProvider };
}

async function providerForBooking(business, bookingId) {
  const row = (await query('SELECT service_type, source FROM bookings WHERE id = $1 AND business_id = $2', [bookingId, business.id])).rows[0];
  if (!row) throw notFound('Reservation not found.');
  return { row, ...(row.source === 'external' ? { mode: 'external', provider: externalBooking } : { mode: 'internal', provider: internalProvider }) };
}

export async function checkAvailability(business, input) {
  const request = availabilitySchema.parse(input);
  const { provider } = await providerFor(business, request.service_type);
  return provider.checkAvailability(business, request);
}

export async function createReservation(business, input, actor) {
  const data = createSchema.parse(input);
  const { provider } = await providerFor(business, data.service_type);
  const result = await provider.createReservation(business, data, actor);
  return { ...result, ...(await afterChange(business, result)) };
}

export async function modifyReservation(business, bookingId, changesInput, optionsInput = {}, actor) {
  const changes = modifySchema.parse(changesInput);
  const options = modifyOptionsSchema.parse(optionsInput);
  if (!Object.keys(changes).length) throw validationError('Nothing to change.');
  const { provider, mode } = await providerForBooking(business, bookingId);
  const result = await provider.modifyReservation(business, Number(bookingId), changes, options, actor);
  const downstream = await afterChange(business, result);
  const promoted = mode === 'internal' && result.freed ? await promoteWaitlist(business, result.freed.service_type) : [];
  return { ...result, ...downstream, promoted };
}

export async function cancelReservation(business, bookingId, { reason = '' } = {}, actor) {
  const { provider, mode } = await providerForBooking(business, bookingId);
  const result = await provider.cancelReservation(business, Number(bookingId), { reason }, actor);
  const downstream = await afterChange(business, result);
  const promoted = mode === 'internal' && result.freed ? await promoteWaitlist(business, result.freed.service_type) : [];
  return { ...result, ...downstream, promoted };
}

export async function getReservation(business, bookingId) {
  const reservation = await fetchReservation(null, business.id, bookingId);
  if (!reservation) throw notFound('Reservation not found.');
  return reservation;
}

export { listReservations, operationsBoard };

/** Staff confirm a held (pending) reservation; inventory is already held by it. */
export async function confirmHeldReservation(business, bookingId, actor) {
  const updated = (await query(
    `UPDATE bookings SET status = 'confirmed', calendar_sync_status = 'pending', updated_at = NOW(),
            review_reason = CASE WHEN review_reason = 'legacy_pending_hold' THEN NULL ELSE review_reason END
     WHERE id = $1 AND business_id = $2 AND status = 'pending' AND waitlisted = FALSE AND source = 'internal' RETURNING id`,
    [Number(bookingId), business.id])).rows[0];
  if (!updated) throw validationError('Only a held, unconfirmed reservation can be confirmed.');
  await recordAudit(null, { businessId: business.id, actor, action: 'status_change', entity: 'booking', entityId: updated.id,
    before: { status: 'pending' }, after: { status: 'confirmed' } });
  const result = { reservation: await fetchReservation(null, business.id, updated.id), events: ['created'] };
  return { ...result, ...(await afterChange(business, result)) };
}

/** Deposits are disclosed requirements; staff record what happened. No money moves here. */
export async function recordDeposit(business, bookingId, status, actor) {
  if (!['recorded_paid', 'waived', 'refunded', 'due'].includes(status)) throw validationError('Unknown deposit status.');
  const updated = (await query(
    `UPDATE bookings SET deposit_status = $3, deposit_recorded_by = $4, deposit_recorded_at = NOW()
     WHERE id = $1 AND business_id = $2 AND deposit_status <> 'not_required' RETURNING id`,
    [Number(bookingId), business.id, status, actor?.userId || null])).rows[0];
  if (!updated) throw validationError('This reservation has no deposit requirement.');
  await recordAudit(null, { businessId: business.id, actor, action: 'deposit', entity: 'booking', entityId: updated.id, after: { deposit_status: status } });
  return { reservation: await fetchReservation(null, business.id, updated.id) };
}

/**
 * Operational-status changes. Internal services update our own state; external
 * services send supported updates to the provider and refuse the rest, so the
 * dashboard never holds status that contradicts the source system.
 */
export async function applyOperation(business, input, actor) {
  const data = operationSchema.parse(input);
  let mode;
  if (RESOURCE_ACTIONS.includes(data.action)) {
    const resource = (await query('SELECT service_type, managed_by FROM resources WHERE id = $1 AND business_id = $2', [data.resource_id, business.id])).rows[0];
    if (!resource) throw notFound('Room or table not found.');
    mode = resource.managed_by === 'external' ? 'external' : 'internal';
  } else {
    mode = (await providerForBooking(business, data.booking_id)).mode;
  }
  const result = mode === 'external' ? await externalBooking.applyOperation(business, data, actor) : await internalOperations.apply(business, data, actor);
  const downstream = result.reservation && result.events?.length ? await afterChange(business, { reservation: result.reservation, events: [] }) : {};
  const promoted = result.freed ? await promoteWaitlist(business, result.freed.service_type) : [];
  return { ...result, ...downstream, promoted };
}

export async function addMaintenance(business, input, actor) {
  const resource = (await query('SELECT managed_by FROM resources WHERE id = $1 AND business_id = $2', [Number(input?.resource_id) || 0, business.id])).rows[0];
  if (resource?.managed_by === 'external') {
    throw new BookingError('unsupported_operation', 'Out-of-service periods for this room are managed in the connected reservation system.');
  }
  return internalOperations.addMaintenance(business, input, actor);
}

export async function removeMaintenance(business, blockId, actor) {
  const result = await internalOperations.removeMaintenance(business, blockId, actor);
  const promoted = [];
  for (const service of ['hotel', 'restaurant', 'meeting']) promoted.push(...await promoteWaitlist(business, service));
  return { ...result, promoted };
}

/**
 * Offer freed inventory to the waitlist, oldest request first. Each candidate
 * is re-evaluated through the same engine with its full party size, dates,
 * duration and type requirements — a waitlist entry is never just flipped.
 */
export async function promoteWaitlist(business, serviceType) {
  const service = await getService(business.id, serviceType);
  if (!service?.enabled || service.booking_source !== 'internal') return [];
  const waiting = (await query(
    `SELECT id FROM bookings WHERE business_id = $1 AND service_type = $2 AND waitlisted = TRUE AND status = 'pending'
       AND starts_at > NOW() ORDER BY created_at, id LIMIT 50`, [business.id, serviceType])).rows;
  const promoted = [];
  for (const { id } of waiting) {
    const result = await internalProvider.promoteWaitlisted(business, id);
    if (!result) continue;
    await afterChange(business, result);
    promoted.push(result.reservation);
  }
  return promoted;
}

/** Nearby options when the exact request cannot be met. All checks go through the provider. */
export async function findAlternatives(business, input, { days = 7 } = {}) {
  const request = availabilitySchema.parse(input);
  const attempt = async (overrides, type) => {
    try {
      const result = await checkAvailability(business, { ...request, ...overrides });
      if (!result.selected) return null;
      return { recommendation_type: type, date: overrides.date || request.date, end_date: overrides.end_date ?? request.end_date,
        start_time: overrides.start_time || request.start_time, end_time: 'end_time' in overrides ? overrides.end_time : request.end_time,
        selected: result.selected, available: result.available };
    } catch (err) {
      if (err instanceof BookingError && err.code === 'validation') return null;
      throw err;
    }
  };
  if (request.preference) {
    const other = await attempt({ preference: undefined }, 'place');
    if (other) return other;
  }
  if (request.service_type !== 'hotel' && request.start_time) {
    const start = parseTime(request.start_time);
    const length = request.end_time ? ((parseTime(request.end_time) - start + 1440) % 1440 || 1440) : null;
    for (let step = 30; step <= 240; step += 30) {
      for (const offset of [step, -step]) {
        const candidate = start + offset;
        if (candidate < 0 || candidate >= 1440 || (length && candidate + length > 1440)) continue;
        const found = await attempt({ start_time: formatMinutes(candidate), end_time: length ? formatMinutes(candidate + length) : undefined }, 'time');
        if (found) return found;
      }
    }
  }
  const nights = request.end_date ? Math.max(1, Math.round((Date.parse(request.end_date) - Date.parse(request.date)) / 86400000)) : 0;
  for (let offset = 1; offset <= days; offset += 1) {
    const date = addDays(request.date, offset);
    const found = await attempt({ date, end_date: request.service_type === 'hotel' ? addDays(date, nights) : undefined }, 'date');
    if (found) return found;
  }
  return null;
}

/** Customer-facing summary of services and current rules, for the AI prompt. */
export async function describeOfferings(business, bookable) {
  const lines = [];
  for (const serviceType of bookable) {
    const service = await getService(business.id, serviceType);
    const types = (await query(
      `SELECT t.name, COUNT(r.id)::int AS n FROM resource_types t
       LEFT JOIN resources r ON r.resource_type_id = t.id AND r.archived_at IS NULL AND r.is_active
       WHERE t.business_id = $1 AND t.service_type = $2 AND t.archived_at IS NULL AND t.is_active GROUP BY t.name ORDER BY t.name`,
      [business.id, serviceType])).rows;
    lines.push(`${serviceType}: ${types.map((type) => type.name).join(', ') || 'available'}` +
      `${service.booking_source === 'external' ? ' (availability confirmed live with the property system)' : ''}`);
  }
  return lines;
}

// ── Background jobs owned by the booking layer ───────────────────────────────
async function businessById(id) {
  return (await query('SELECT * FROM businesses WHERE id = $1', [id])).rows[0];
}

registerJobHandler('resolve_command', async (job) => {
  const business = await businessById(job.business_id);
  const outcome = await externalBooking.resolveCommand(business, job.payload.command_id);
  if (!outcome.settled) return { retry: true, error: 'The connected system has not confirmed this request yet.' };
  if (outcome.events?.length) await afterChange(business, outcome);
  return { settled: true };
});

registerJobHandler('reconcile', async (job) => {
  const business = await businessById(job.business_id);
  const outcome = await externalBooking.reconcile(business, job.integration_id);
  for (const item of outcome.results.filter((entry) => entry.booking_id && entry.outcome === 'applied')) {
    await afterChange(business, { reservation: await fetchReservation(null, business.id, item.booking_id), events: [] });
  }
  return { received: outcome.received };
});

registerJobHandler('refresh_reservation', async (job) => {
  const business = await businessById(job.business_id);
  await externalBooking.refreshReservation(business, job.payload.booking_id);
  return {};
});

registerJobHandler('process_webhook', async (job) => {
  const business = await businessById(job.business_id);
  const integration = (await query('SELECT * FROM integrations WHERE id = $1 AND business_id = $2', [job.integration_id, job.business_id])).rows[0];
  if (!integration) return {};
  const events = job.payload.events.map((event) => ({ ...event,
    reservation: { ...event.reservation, starts_at: new Date(event.reservation.starts_at), ends_at: new Date(event.reservation.ends_at) } }));
  const results = await externalBooking.applyInboundEvents(business, integration, events, 'webhook');
  for (const item of results.filter((entry) => entry.booking_id && entry.outcome === 'applied')) {
    await afterChange(business, { reservation: await fetchReservation(null, business.id, item.booking_id), events: [] });
  }
  return { applied: results.filter((entry) => entry.outcome === 'applied').length };
});

export { externalBooking, HOLDING_STATUSES, toDateKey, displayDate };
