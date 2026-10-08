// External-system mode: a connected PMS / reservation system is the
// authoritative record. Local `bookings` rows are mirrors for display.
//
// Rules enforced here:
//  • availability is always asked of the provider — nothing is served from cache;
//  • a reservation is confirmed only after the provider acknowledges it;
//  • a provider failure NEVER falls back to an internal booking;
//  • an unknown outcome is reconciled by reference before anything is resubmitted;
//  • a synchronization failure never changes a reservation's status.
import { query, withTransaction } from '../services/db.js';
import { BookingError, ProviderError, notFound, validationError } from '../platform/errors.js';
import { resolveConfig } from '../platform/config.js';
import { recordAudit } from '../platform/audit.js';
import { toMinor, fromMinor } from '../platform/money.js';
import { zonedParts, toDateKey, addDays, diffDays } from '../platform/time.js';
import { connectorContext, getIntegration } from '../platform/integrations.js';
import { planInterval, quoteHash } from './engine.js';
import { fetchReservation, beginCommand, finishCommand, requestHash, upsertCustomer } from './reservations.js';
import { enqueueJob } from './sync/jobs.js';

const MAX_ABSENT_LOOKUPS = 3;

async function sourceFor(business, serviceType) {
  const service = (await query('SELECT * FROM business_services WHERE business_id = $1 AND service_type = $2', [business.id, serviceType])).rows[0];
  if (!service || !service.enabled) throw validationError(`${serviceType} bookings are not offered by this business.`, { reason: 'service_not_enabled' });
  if (service.booking_source !== 'external' || !service.integration_id) {
    throw new BookingError('provider_error', 'No external reservation system is connected for this service.');
  }
  const integration = await getIntegration(business.id, service.integration_id);
  if (!integration || integration.status === 'disabled') {
    throw new ProviderError('The connected reservation system is disabled.', { kind: 'unavailable' });
  }
  const { connector, ctx } = connectorContext(integration);
  return { service, integration, connector, ctx };
}

function planFor(business, service, request) {
  const local = { business, serviceType: service.service_type, closures: [] };
  const planned = planInterval(local, resolveConfig(service.service_type, service.settings).values, request);
  if (!planned.plan) throw validationError(planned.message, { reason: planned.rule });
  return planned.plan;
}

async function typeMappings(integrationId) {
  const rows = (await query(
    `SELECT m.external_id, m.kind, m.resource_type_id, m.resource_id, t.name AS type_name, r.code AS resource_code
     FROM external_mappings m LEFT JOIN resource_types t ON t.id = m.resource_type_id LEFT JOIN resources r ON r.id = m.resource_id
     WHERE m.integration_id = $1`, [integrationId])).rows;
  return {
    type: new Map(rows.filter((row) => row.kind === 'resource_type').map((row) => [row.external_id, row])),
    unit: new Map(rows.filter((row) => row.kind === 'resource').map((row) => [row.external_id, row])),
  };
}

function externalQuote(business, option, plan, people) {
  const currency = business.currency;
  const rate = toMinor(option.rate || '0', currency);
  const quantity = plan.nights ?? 1;
  const total = rate * quantity;
  const quote = {
    currency,
    lines: [{ code: plan.nights ? 'accommodation' : 'reservation', label: `${option.type_name} × ${quantity}`,
      unit_amount: fromMinor(rate, currency), quantity, amount: fromMinor(total, currency) }],
    subtotal: fromMinor(total, currency), booking_fee: fromMinor(0, currency), total: fromMinor(total, currency),
    minimum_spend: fromMinor(0, currency),
    deposit: { required: false, amount: fromMinor(0, currency), rule: { type: 'none' }, collection: 'Handled by the connected reservation system.' },
    policies: { priced_by: 'external', people },
    resource_type: { id: option.resource_type_id, name: option.type_name },
  };
  quote.hash = quoteHash(quote);
  return quote;
}

async function authoritativeOptions(business, source, request, plan) {
  const remote = await source.connector.checkAvailability(source.ctx, {
    service_type: request.service_type, starts_at: plan.starts_at, ends_at: plan.ends_at, people: request.people });
  const maps = await typeMappings(source.integration.id);
  const tokens = String(request.preference || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token && !['room', 'table', 'a', 'the'].includes(token));
  const options = remote.options.map((option) => {
    const mapping = maps.type.get(option.external_type_id);
    const typeName = mapping?.type_name || option.name;
    return { external_type_id: option.external_type_id, resource_type_id: mapping?.resource_type_id ? Number(mapping.resource_type_id) : null,
      type_name: typeName, capacity: option.capacity, rate: option.rate, available: option.available_units > 0 && Boolean(mapping?.resource_type_id),
      mapped: Boolean(mapping?.resource_type_id),
      preferred: !tokens.length || tokens.every((token) => typeName.toLowerCase().includes(token)) };
  }).filter((option) => !request.resource_type_id || option.resource_type_id === request.resource_type_id);
  options.sort((a, b) => Number(b.available) - Number(a.available) || Number(b.preferred) - Number(a.preferred) || a.capacity - b.capacity);
  const selected = options.find((option) => option.available && option.preferred) || (tokens.length ? null : options.find((option) => option.available)) || null;
  return { remote, options, selected };
}

function describe(business, option, plan, people) {
  // Only a room TYPE is offered: this provider assigns the physical room later.
  return { resource: null, resource_type: { id: option.resource_type_id, name: option.type_name }, capacity: option.capacity,
    available: option.available, reason: option.available ? null : option.mapped ? 'booked' : 'unmapped',
    external_type_id: option.external_type_id, ...(option.available ? { quote: externalQuote(business, option, plan, people) } : {}) };
}

function localTimes(business, startsAt, endsAt, serviceType) {
  const start = zonedParts(startsAt, business.timezone);
  const end = zonedParts(endsAt, business.timezone);
  return { date: start.date, end_date: serviceType === 'hotel' ? end.date : null, start_time: start.time, end_time: end.time };
}

/** Write (or refresh) the local mirror from what the provider reported. */
async function writeMirror(db, business, integration, remote, extra = {}) {
  const maps = await typeMappings(integration.id);
  const type = maps.type.get(remote.external_type_id);
  // A physical room is recorded only when the provider assigned one AND it is mapped.
  const unit = remote.external_resource_id ? maps.unit.get(remote.external_resource_id) : null;
  const times = localTimes(business, remote.starts_at, remote.ends_at, remote.service_type);
  const existing = extra.bookingId
    ? (await db.query('SELECT * FROM bookings WHERE id = $1 AND business_id = $2 FOR UPDATE', [extra.bookingId, business.id])).rows[0]
    : (await db.query(
      `SELECT * FROM bookings WHERE business_id = $1 AND integration_id = $2
         AND (external_reservation_id = $3 OR ($4::uuid IS NOT NULL AND correlation_id = $4 AND external_reservation_id IS NULL))
       ORDER BY (external_reservation_id = $3) DESC NULLS LAST LIMIT 1 FOR UPDATE`,
      [business.id, integration.id, remote.external_reservation_id, isUuid(remote.correlation_id) ? remote.correlation_id : null])).rows[0];
  if (existing && existing.external_version !== null && Number(existing.external_version) >= remote.version) {
    return { bookingId: existing.id, outcome: 'stale', previousStatus: existing.status };
  }
  if (existing) {
    await db.query(
      `UPDATE bookings SET external_reservation_id = $3, external_version = $4, status = $5, sync_status = 'synced', sync_checked_at = NOW(),
         attention_reason = NULL, reservation_name = COALESCE($6, reservation_name), people = COALESCE($7, people),
         date = $8, end_date = $9, start_time = $10, end_time = $11, starts_at = $12, ends_at = $13,
         resource_type_id = COALESCE($14, resource_type_id), resource_id = $15,
         total_amount = COALESCE($16, total_amount), calendar_sync_status = 'pending', updated_at = NOW()
       WHERE id = $1 AND business_id = $2`,
      [existing.id, business.id, remote.external_reservation_id, remote.version, remote.status, remote.guest_name || null, remote.party_size || null,
        times.date, times.end_date, times.start_time, times.end_time, remote.starts_at, remote.ends_at,
        type?.resource_type_id || null, unit?.resource_id || null, remote.total ?? null]);
    return { bookingId: existing.id, outcome: 'applied', previousStatus: existing.status };
  }
  const inserted = (await db.query(
    `INSERT INTO bookings (business_id, session_id, service_type, resource_id, resource_type_id, customer_id, reservation_name, contact_phone,
        contact_email, people, date, end_date, start_time, end_time, starts_at, ends_at, status, notes, source, channel, integration_id,
        external_reservation_id, external_version, correlation_id, sync_status, sync_checked_at, quote, currency, total_amount,
        idempotency_key, created_by_user_id, calendar_sync_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'external', $19, $20, $21, $22, $23,
             'synced', NOW(), $24::jsonb, $25, $26, $27, $28, 'pending') RETURNING id`,
    [business.id, extra.sessionId || `external:${integration.id}`, remote.service_type, unit?.resource_id || null, type?.resource_type_id || null,
      extra.customerId || null, remote.guest_name || extra.customer?.name || null, extra.customer?.phone || null, extra.customer?.email || null,
      remote.party_size || extra.people || 1, times.date, times.end_date, times.start_time, times.end_time, remote.starts_at, remote.ends_at,
      remote.status, extra.notes || '', extra.channel || 'external', integration.id, remote.external_reservation_id, remote.version,
      isUuid(remote.correlation_id) ? remote.correlation_id : null, extra.quote ? JSON.stringify(extra.quote) : null,
      extra.quote?.currency || business.currency, remote.total ?? extra.quote?.total ?? null, extra.idempotencyKey || null, extra.userId || null])).rows[0];
  return { bookingId: inserted.id, outcome: 'applied', previousStatus: null };
}

const isUuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

async function recordSync(db, business, integration, event) {
  const run = db ? db.query.bind(db) : query;
  await run(
    `INSERT INTO sync_events (business_id, integration_id, direction, event_type, external_event_id, external_reservation_id,
        external_version, booking_id, outcome, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [business.id, integration.id, event.direction, event.type, event.eventId || null, event.reservationId || null, event.version ?? null,
      event.bookingId || null, event.outcome, JSON.stringify(event.detail || {})]);
}

export const externalBooking = {
  async checkAvailability(business, request) {
    const source = await sourceFor(business, request.service_type);
    const plan = planFor(business, source.service, request);
    const { remote, options, selected } = await authoritativeOptions(business, source, request, plan);
    return {
      service_type: request.service_type, source: 'external',
      provider: { name: source.integration.name, is_mock: source.integration.environment === 'mock' },
      // Asked of the authoritative system just now; never a cached answer.
      freshness: { authoritative: true, checked_at: remote.fetched_at, cached: false },
      available: options.filter((option) => option.available).length, total: options.length,
      reason: selected ? { code: 'available', message: '' } : { code: 'full', message: 'The connected reservation system has no availability for that request.' },
      selected: selected ? describe(business, selected, plan, request.people) : null,
      plan: selected ? plan : null,
      options: options.map((option) => describe(business, option, plan, request.people)),
      other_available: [], waitlist_possible: false,
    };
  },

  async createReservation(business, data, actor) {
    const source = await sourceFor(business, data.service_type);
    if (data.immediate || data.waitlist_if_unavailable || data.hold) {
      throw new BookingError('unsupported_operation',
        `Walk-ins, holds and waitlists for this service are managed in ${source.integration.name}. Record it there; it will appear here after synchronization.`);
    }
    const plan = planFor(business, source.service, data);

    // 1. The command is committed BEFORE any remote call, so a crash or timeout
    //    always leaves a record that can be reconciled.
    const { command, fresh } = await withTransaction((db) => beginCommand(db, business.id, {
      key: data.idempotency_key, command: 'create', serviceType: data.service_type, provider: source.connector.key, hash: requestHash(data) }));
    if (!fresh) {
      if (command.status === 'succeeded') {
        return { reservation: await fetchReservation(null, business.id, command.booking_id), idempotent_replay: true, events: [] };
      }
      if (command.status === 'failed') throw new BookingError(command.error?.code || 'provider_error', command.error?.message || 'The earlier attempt failed.', command.error?.details || {});
      // Outcome still unknown: look it up. Never submit a second reservation.
      return { ...(await this.resolveCommand(business, command.id)), idempotent_replay: true };
    }

    const fail = async (err) => {
      await finishCommand({ query }, command.id, { status: 'failed', error: { code: err.code, message: err.message, details: err.details } });
      await recordSync(null, business, source.integration, { direction: 'outbound', type: 'reservation.create', outcome: 'failed',
        detail: { correlation_id: command.correlation_id, error: err.message } });
      throw err;
    };

    // 2. Authoritative availability, then the customer's accepted terms.
    let selected;
    try {
      ({ selected } = await authoritativeOptions(business, source, data, plan));
    } catch (err) { return fail(err instanceof BookingError ? err : new ProviderError(err.message)); }
    if (!selected) return fail(new BookingError('conflict', 'The connected reservation system has no availability for that request.', { reason: 'full', waitlist_possible: false }));
    const quote = externalQuote(business, selected, plan, data.people);
    if (data.channel === 'chat' && !data.accepted_quote_hash) return fail(validationError('The customer must accept the quoted terms before a reservation is created.'));
    if (data.accepted_quote_hash && data.accepted_quote_hash !== quote.hash) {
      return fail(new BookingError('quote_changed', 'The price or booking terms changed. Please review and confirm again.',
        { quote, option: describe(business, selected, plan, data.people) }));
    }

    // 3. Submit. Only an acknowledgement produces a confirmed reservation.
    let remote = null;
    let unknown = null;
    try {
      remote = await source.connector.createReservation(source.ctx, { service_type: data.service_type, external_type_id: selected.external_type_id,
        correlation_id: command.correlation_id, idempotency_key: data.idempotency_key, guest_name: data.customer.name, people: data.people,
        starts_at: plan.starts_at, ends_at: plan.ends_at, total: quote.total });
    } catch (err) {
      if (!(err instanceof ProviderError) || !err.outcomeUnknown) return fail(err instanceof BookingError ? err : new ProviderError(err.message));
      unknown = err;
      // The request may have been accepted. Look for it by our reference once, right away.
      try { remote = await source.connector.findByCorrelationId(source.ctx, command.correlation_id); } catch { remote = null; }
    }

    return withTransaction(async (db) => {
      const customerId = await upsertCustomer(db, business.id, data.customer);
      const extra = { customerId, customer: data.customer, people: data.people, notes: data.notes, channel: data.channel,
        sessionId: data.session_id, quote, idempotencyKey: data.idempotency_key, userId: actor?.userId };
      if (remote) {
        const mirror = await writeMirror(db, business, source.integration, remote, extra);
        await finishCommand(db, command.id, { status: 'succeeded', bookingId: mirror.bookingId, result: { external_reservation_id: remote.external_reservation_id } });
        await recordSync(db, business, source.integration, { direction: 'outbound', type: 'reservation.create', outcome: 'applied',
          reservationId: remote.external_reservation_id, version: remote.version, bookingId: mirror.bookingId, detail: { correlation_id: command.correlation_id } });
        const reservation = await fetchReservation(db, business.id, mirror.bookingId);
        await recordAudit(db, { businessId: business.id, actor, action: 'create', entity: 'booking', entityId: mirror.bookingId,
          after: { status: reservation.status, source: 'external', external_reservation_id: remote.external_reservation_id } });
        return { reservation, idempotent_replay: false, events: ['created'] };
      }
      // Outcome unknown: keep a clearly unconfirmed local record and reconcile.
      const times = localTimes(business, plan.starts_at, plan.ends_at, data.service_type);
      const row = (await db.query(
        `INSERT INTO bookings (business_id, session_id, service_type, resource_type_id, customer_id, reservation_name, contact_phone, contact_email,
            people, date, end_date, start_time, end_time, starts_at, ends_at, status, notes, source, channel, integration_id, correlation_id,
            sync_status, attention_reason, quote, currency, total_amount, idempotency_key, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'awaiting_confirmation', $16, 'external', $17, $18, $19,
                 'unknown', $20, $21::jsonb, $22, $23, $24, $25) RETURNING id`,
        [business.id, data.session_id || `staff:${actor?.userId || 'system'}`, data.service_type, selected.resource_type_id, customerId,
          data.customer.name, data.customer.phone || null, data.customer.email || null, data.people, times.date, times.end_date,
          times.start_time, times.end_time, plan.starts_at, plan.ends_at, data.notes, data.channel, source.integration.id, command.correlation_id,
          `${source.integration.name} did not answer in time. Checking whether the reservation was created.`,
          JSON.stringify(quote), quote.currency, quote.total, data.idempotency_key, actor?.userId || null])).rows[0];
      await finishCommand(db, command.id, { status: 'unknown', bookingId: row.id, error: { code: unknown.code, message: unknown.message } });
      await recordSync(db, business, source.integration, { direction: 'outbound', type: 'reservation.create', outcome: 'unknown',
        bookingId: row.id, detail: { correlation_id: command.correlation_id, error: unknown.message } });
      await enqueueJob(db, { businessId: business.id, integrationId: source.integration.id, kind: 'resolve_command',
        dedupeKey: `command:${command.id}`, payload: { command_id: Number(command.id) }, delayMs: 5000 });
      return { reservation: await fetchReservation(db, business.id, row.id), idempotent_replay: false, events: ['awaiting_confirmation'] };
    });
  },

  /**
   * Settle a command whose outcome is unknown by looking the reservation up by
   * our reference. Throws ProviderError when the provider cannot be reached, so
   * the durable job retries later.
   */
  async resolveCommand(business, commandId) {
    const command = (await query('SELECT * FROM booking_commands WHERE id = $1 AND business_id = $2', [commandId, business.id])).rows[0];
    if (!command) throw notFound('Command not found.');
    if (command.status === 'succeeded' || command.status === 'failed') {
      return { reservation: await fetchReservation(null, business.id, command.booking_id), events: [], settled: true };
    }
    const source = await sourceFor(business, command.service_type);
    const capabilities = await source.connector.capabilities(source.ctx);
    if (!capabilities.lookup_by_correlation) {
      await this.flagAttention(business, command, `${source.integration.name} cannot be asked about this request. Check it there before rebooking.`);
      return { reservation: await fetchReservation(null, business.id, command.booking_id), events: [], settled: true };
    }
    const remote = await source.connector.findByCorrelationId(source.ctx, command.correlation_id);
    if (!remote) {
      const attempts = Number((await query('UPDATE booking_commands SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts', [command.id])).rows[0].attempts);
      if (attempts <= MAX_ABSENT_LOOKUPS) return { reservation: await fetchReservation(null, business.id, command.booking_id), events: [], settled: false };
      await this.flagAttention(business, command, `${source.integration.name} has no record of this request. Staff must check before rebooking.`);
      return { reservation: await fetchReservation(null, business.id, command.booking_id), events: [], settled: true };
    }
    return withTransaction(async (db) => {
      const mirror = await writeMirror(db, business, source.integration, remote, { bookingId: command.booking_id });
      await finishCommand(db, command.id, { status: 'succeeded', bookingId: mirror.bookingId, result: { external_reservation_id: remote.external_reservation_id } });
      await recordSync(db, business, source.integration, { direction: 'outbound', type: 'reservation.reconciled', outcome: 'applied',
        reservationId: remote.external_reservation_id, version: remote.version, bookingId: mirror.bookingId, detail: { correlation_id: command.correlation_id } });
      return { reservation: await fetchReservation(db, business.id, mirror.bookingId), settled: true,
        events: mirror.previousStatus === 'awaiting_confirmation' && remote.status === 'confirmed' ? ['created'] : [] };
    });
  },

  async flagAttention(business, command, message) {
    await withTransaction(async (db) => {
      await db.query(`UPDATE bookings SET sync_status = 'attention', attention_reason = $3, sync_checked_at = NOW() WHERE id = $1 AND business_id = $2`,
        [command.booking_id, business.id, message]);
      await finishCommand(db, command.id, { status: 'failed', error: { code: 'provider_error', message } });
    });
  },

  async modifyReservation(business, bookingId, changes, options, actor) {
    const row = (await query('SELECT * FROM bookings WHERE id = $1 AND business_id = $2', [bookingId, business.id])).rows[0];
    if (!row) throw notFound('Reservation not found.');
    if (!['confirmed', 'modified', 'checked_in'].includes(row.status) || !row.external_reservation_id) {
      throw validationError(row.status === 'awaiting_confirmation'
        ? 'This reservation is still awaiting confirmation from the connected system and cannot be changed yet.' : 'That reservation is no longer active.');
    }
    const source = await sourceFor(business, row.service_type);
    const remoteFields = ['date', 'end_date', 'start_time', 'end_time', 'people', 'reservation_name'].filter((field) => field in changes);
    for (const field of ['resource_id', 'resource_type_id', 'layout']) {
      if (field in changes) throw new BookingError('unsupported_operation', `Room assignment is managed in ${source.integration.name}.`);
    }
    let remote = null;
    if (remoteFields.length) {
      // Moving the arrival keeps the number of nights unless a new checkout is given.
      const keptEnd = row.service_type === 'hotel' && changes.date && !changes.end_date && row.end_date
        ? addDays(changes.date, diffDays(toDateKey(row.date), toDateKey(row.end_date))) : null;
      const next = { service_type: row.service_type, date: changes.date || toDateKey(row.date),
        end_date: changes.end_date || keptEnd || toDateKey(row.end_date) || undefined,
        start_time: changes.start_time || String(row.start_time || '').slice(0, 5) || undefined,
        end_time: changes.end_time || String(row.end_time || '').slice(0, 5) || undefined, people: changes.people || row.people,
        allow_past: !('date' in changes) };
      const plan = planFor(business, source.service, next);
      try {
        // The change is sent to the provider first; our copy is untouched until it accepts.
        remote = await source.connector.modifyReservation(source.ctx, row.external_reservation_id, {
          starts_at: plan.starts_at, ends_at: plan.ends_at, people: next.people, guest_name: changes.reservation_name });
      } catch (err) {
        if (err instanceof ProviderError && err.outcomeUnknown) {
          await query(`UPDATE bookings SET sync_status = 'unknown', attention_reason = 'A change was sent but not acknowledged; verifying.' WHERE id = $1`, [row.id]);
          await enqueueJob(null, { businessId: business.id, integrationId: source.integration.id, kind: 'refresh_reservation',
            dedupeKey: `booking:${row.id}`, payload: { booking_id: row.id } });
        }
        if (err instanceof ProviderError && err.kind === 'unsupported') {
          throw new BookingError('unsupported_operation', `${err.message} Make this change in ${source.integration.name}.`);
        }
        if (err instanceof ProviderError && err.kind === 'rejected') throw new BookingError('conflict', err.message, { reason: 'full', unchanged: true });
        throw err;
      }
    }
    return withTransaction(async (db) => {
      if (remote) await writeMirror(db, business, source.integration, remote, { bookingId: row.id });
      await db.query(
        `UPDATE bookings SET contact_phone = $3, contact_email = $4, notes = $5, updated_at = NOW() WHERE id = $1 AND business_id = $2`,
        [row.id, business.id, changes.contact_phone ?? row.contact_phone, 'contact_email' in changes ? (changes.contact_email || null) : row.contact_email,
          changes.notes ?? row.notes]);
      if (remote) await recordSync(db, business, source.integration, { direction: 'outbound', type: 'reservation.modify', outcome: 'applied',
        reservationId: remote.external_reservation_id, version: remote.version, bookingId: row.id });
      const reservation = await fetchReservation(db, business.id, row.id);
      await recordAudit(db, { businessId: business.id, actor, action: 'update', entity: 'booking', entityId: row.id,
        before: { date: toDateKey(row.date), end_date: toDateKey(row.end_date), people: row.people },
        after: { date: reservation.date, end_date: reservation.end_date, people: reservation.people } });
      return { reservation, events: ['modified'], schedule_changed: Boolean(remote) };
    });
  },

  async cancelReservation(business, bookingId, { reason = '' } = {}, actor) {
    const row = (await query('SELECT * FROM bookings WHERE id = $1 AND business_id = $2', [bookingId, business.id])).rows[0];
    if (!row) throw notFound('Reservation not found.');
    if (row.status === 'cancelled') return { reservation: await fetchReservation(null, business.id, row.id), idempotent_replay: true, events: [] };
    const source = await sourceFor(business, row.service_type);
    let remote = null;
    if (row.external_reservation_id) {
      try {
        remote = await source.connector.cancelReservation(source.ctx, row.external_reservation_id);
      } catch (err) {
        if (err instanceof ProviderError && err.kind === 'unsupported') {
          throw new BookingError('unsupported_operation', `${err.message} Cancel it in ${source.integration.name}.`);
        }
        throw err;   // our copy stays exactly as it was
      }
    } else if (row.sync_status !== 'attention') {
      throw validationError('This request is still being verified with the connected system. It can be withdrawn once that check finishes.');
    }
    return withTransaction(async (db) => {
      if (remote) await writeMirror(db, business, source.integration, remote, { bookingId: row.id });
      await db.query(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $3, attention_reason = NULL,
           sync_status = CASE WHEN external_reservation_id IS NULL THEN 'not_applicable' ELSE 'synced' END, calendar_sync_status = 'pending'
         WHERE id = $1 AND business_id = $2`, [row.id, business.id, reason]);
      await recordAudit(db, { businessId: business.id, actor, action: 'cancel', entity: 'booking', entityId: row.id,
        before: { status: row.status }, after: { status: 'cancelled', reason } });
      return { reservation: await fetchReservation(db, business.id, row.id), idempotent_replay: false, events: ['cancelled'] };
    });
  },

  /** Send a supported operational update through the provider; refuse the rest. */
  async applyOperation(business, data, actor) {
    if (!data.booking_id) {
      throw new BookingError('unsupported_operation',
        'Housekeeping and readiness for this service are managed in the connected reservation system. Update it there to avoid conflicting status.');
    }
    const row = (await query('SELECT * FROM bookings WHERE id = $1 AND business_id = $2', [data.booking_id, business.id])).rows[0];
    if (!row) throw notFound('Reservation not found.');
    const source = await sourceFor(business, row.service_type);
    const capabilities = await source.connector.capabilities(source.ctx);
    if (!row.external_reservation_id || !(capabilities.operational_updates || []).includes(data.action)) {
      throw new BookingError('unsupported_operation',
        `"${data.action.replace(/_/g, ' ')}" cannot be sent to ${source.integration.name}. Do it there; this dashboard will update after synchronization.`,
        { supported: capabilities.operational_updates || [] });
    }
    const remote = await source.connector.applyOperationalUpdate(source.ctx, row.external_reservation_id, data.action);
    return withTransaction(async (db) => {
      await writeMirror(db, business, source.integration, remote, { bookingId: row.id });
      await db.query(
        `INSERT INTO operational_events (business_id, resource_id, booking_id, action, note, actor_user_id, actor_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [business.id, row.resource_id, row.id, data.action, data.note || '', actor?.userId || null, actor?.email || '']);
      return { reservation: await fetchReservation(db, business.id, row.id), events: [] };
    });
  },

  /**
   * Apply updates that originated in the external system (webhook or
   * reconciliation). Safe against duplicates and out-of-order delivery.
   */
  async applyInboundEvents(business, integration, events, via) {
    const results = [];
    for (const event of events) {
      const outcome = await withTransaction(async (db) => {
        // Serialize per integration so two deliveries of one event cannot both apply.
        await db.query('SELECT pg_advisory_xact_lock($1, $2)', [918273, Number(integration.id)]);
        const seen = (await db.query(
          `SELECT 1 FROM sync_events WHERE integration_id = $1 AND direction = 'inbound' AND external_event_id = $2
             AND outcome IN ('applied', 'stale', 'ignored')`, [integration.id, event.event_id])).rows.length;
        const base = { direction: 'inbound', type: event.event_type, reservationId: event.reservation.external_reservation_id,
          version: event.reservation.version, detail: { via } };
        if (seen) {
          await recordSync(db, business, integration, { ...base, eventId: null, outcome: 'duplicate', detail: { via, duplicate_of: event.event_id } });
          return { event_id: event.event_id, outcome: 'duplicate' };
        }
        const mirror = await writeMirror(db, business, integration, event.reservation);
        await recordSync(db, business, integration, { ...base, eventId: event.event_id, outcome: mirror.outcome, bookingId: mirror.bookingId });
        return { event_id: event.event_id, outcome: mirror.outcome, booking_id: mirror.bookingId,
          became_cancelled: mirror.outcome === 'applied' && event.reservation.status === 'cancelled' && mirror.previousStatus !== 'cancelled' };
      });
      results.push(outcome);
    }
    return results;
  },

  /** Pull changes we may have missed. The cursor only advances after the whole batch applied. */
  async reconcile(business, integrationId) {
    const integration = await getIntegration(business.id, integrationId);
    if (!integration) throw notFound('Integration not found.');
    const { connector, ctx } = connectorContext(integration);
    let changes;
    try {
      changes = await connector.listChanges(ctx, integration.sync_cursor);
    } catch (err) {
      await query('UPDATE integrations SET last_error = $2 WHERE id = $1', [integration.id, String(err.message).slice(0, 300)]);
      throw err;
    }
    const results = await this.applyInboundEvents(business, integration, changes.events, 'reconciliation');
    await query('UPDATE integrations SET sync_cursor = $2, last_reconciled_at = NOW(), last_error = NULL WHERE id = $1', [integration.id, changes.cursor]);
    return { received: changes.events.length, results };
  },

  /** Re-read one reservation from the provider (after an unacknowledged change). */
  async refreshReservation(business, bookingId) {
    const row = (await query('SELECT * FROM bookings WHERE id = $1 AND business_id = $2', [bookingId, business.id])).rows[0];
    if (!row?.external_reservation_id) return null;
    const source = await sourceFor(business, row.service_type);
    const remote = await source.connector.getReservation(source.ctx, row.external_reservation_id);
    if (!remote) return null;
    return withTransaction(async (db) => {
      const mirror = await writeMirror(db, business, source.integration, remote, { bookingId: row.id });
      if (mirror.outcome === 'stale') {
        await db.query(`UPDATE bookings SET sync_status = 'synced', attention_reason = NULL, sync_checked_at = NOW() WHERE id = $1`, [row.id]);
      }
      return fetchReservation(db, business.id, row.id);
    });
  },
};
