// Internal booking provider: our PostgreSQL database is the authoritative
// record. The final availability check and the write happen in ONE transaction
// on ONE connection, behind row locks, with an exclusion constraint as the
// last line of defence.
import { query, withTransaction } from '../../services/db.js';
import { BookingError, notFound, validationError } from '../../platform/errors.js';
import { resolveConfig } from '../../platform/config.js';
import { recordAudit } from '../../platform/audit.js';
import { toDateKey, addDays, diffDays, parseTime, formatMinutes, todayKey } from '../../platform/time.js';
import { loadContext, evaluate, buildQuote, planInterval } from '../engine.js';
import { fetchReservation, beginCommand, finishCommand, requestHash, upsertCustomer } from '../reservations.js';
import { SCHEDULE_FIELDS } from '../schemas.js';

const ACTIVE = ['pending', 'confirmed', 'modified', 'checked_in'];
const pooled = { query: (text, params) => query(text, params) };

function unavailable(result) {
  const reason = result.reason || { code: 'unavailable', message: 'Nothing is available for that request.' };
  return new BookingError('conflict', reason.message, {
    reason: reason.code,
    // Only a genuinely full house can be waitlisted; a rule violation cannot.
    waitlist_possible: ['full', 'maintenance'].includes(reason.code),
  });
}

function assertInternal(ctx) {
  if (ctx.service.booking_source !== 'internal') {
    throw new BookingError('unsupported_operation', 'This service is booked through an external system.');
  }
}

function quoteColumns(quote) {
  return quote ? [JSON.stringify(quote), quote.currency, quote.total, quote.booking_fee, quote.minimum_spend, quote.deposit.amount,
    quote.deposit.required ? 'due' : 'not_required'] : [null, null, null, null, null, null, 'not_required'];
}

/** A requested interval validated against service-level rules only (used for
 * waitlist entries, which have no resource yet). */
function servicePlan(ctx, request) {
  const config = resolveConfig(ctx.serviceType, ctx.service.settings).values;
  const planned = planInterval(ctx, config, request);
  if (!planned.plan) throw validationError(planned.message, { reason: planned.rule });
  return planned.plan;
}

function mapConstraint(err) {
  if (err?.code === '23P01') {
    return new BookingError('conflict', 'That room or table was just taken by another reservation.', { reason: 'full', waitlist_possible: true });
  }
  return err;
}

export function describeOption(option, quote) {
  return {
    resource: { id: option.resource.id, code: option.resource.code, name: option.resource.name },
    resource_type: { id: option.resource.type_id, name: option.resource.type_name },
    capacity: option.capacity, available: option.available, reason: option.reason, message: option.message,
    ready_now: option.resource.operational_status === 'ready',
    operational_status: option.resource.operational_status,
    ...(quote ? { quote } : {}),
  };
}

export const internalProvider = {
  key: 'internal',

  async checkAvailability(business, request) {
    const ctx = await loadContext(pooled, business, request.service_type);
    assertInternal(ctx);
    const result = await evaluate(pooled, ctx, request);
    const selected = result.selected;
    return {
      service_type: request.service_type,
      source: 'internal',
      freshness: { authoritative: true, checked_at: new Date().toISOString(), cached: false },
      available: result.available,
      total: result.options.length,
      reason: selected ? { code: 'available', message: '' } : result.reason,
      selected: selected ? describeOption(selected, buildQuote(ctx, selected, request)) : null,
      plan: selected ? selected.plan : null,
      options: result.options.map((option) => describeOption(option, option.available ? buildQuote(ctx, option, request) : null)),
      other_available: result.other_available.map((option) => describeOption(option, buildQuote(ctx, option, request))),
      waitlist_possible: !selected && ['full', 'maintenance'].includes(result.reason.code),
    };
  },

  async createReservation(business, data, actor) {
    try {
      return await withTransaction(async (db) => {
        const { command, fresh } = await beginCommand(db, business.id, {
          key: data.idempotency_key, command: 'create', serviceType: data.service_type, hash: requestHash(data) });
        if (!fresh) {
          // A retry or double-click: hand back the original reservation.
          return { reservation: await fetchReservation(db, business.id, command.booking_id), idempotent_replay: true, events: [] };
        }
        const ctx = await loadContext(db, business, data.service_type, { lock: true });
        assertInternal(ctx);
        const result = await evaluate(db, ctx, data);
        const option = result.selected;
        if (!option && !(data.waitlist_if_unavailable && ['full', 'maintenance'].includes(result.reason.code))) throw unavailable(result);

        const quote = option ? buildQuote(ctx, option, data) : null;
        if (quote && data.channel === 'chat' && !data.accepted_quote_hash) {
          throw validationError('The customer must accept the quoted terms before a reservation is created.');
        }
        if (quote && data.accepted_quote_hash && data.accepted_quote_hash !== quote.hash) {
          throw new BookingError('quote_changed', 'The price or booking terms changed. Please review and confirm again.', { quote,
            option: describeOption(option, quote) });
        }
        const plan = option ? option.plan : servicePlan(ctx, data);
        const status = !option || data.hold ? 'pending' : data.immediate ? 'checked_in' : 'confirmed';
        const customerId = await upsertCustomer(db, business.id, data.customer);

        const row = (await db.query(
          `INSERT INTO bookings (business_id, session_id, service_type, resource_id, resource_type_id, customer_id,
              reservation_name, contact_phone, contact_email, people, layout, preferred_inventory, date, end_date, start_time, end_time,
              starts_at, ends_at, hold_period, status, waitlisted, notes, source, channel, idempotency_key, correlation_id,
              created_by_user_id, service_started_at, quote, currency, total_amount, booking_fee_amount, min_spend_amount,
              deposit_amount, deposit_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                   CASE WHEN $4::bigint IS NULL THEN NULL ELSE tstzrange($19, $20, '[)') END,
                   $21, $22, $23, 'internal', $24, $25, $26, $27, $28, $29::jsonb, $30, $31, $32, $33, $34, $35)
           RETURNING id`,
          [business.id, data.session_id || `staff:${actor?.userId || 'system'}`, data.service_type,
            option?.resource.id || null, option?.resource.type_id || data.resource_type_id || null, customerId,
            data.customer.name, data.customer.phone || null, data.customer.email || null, data.people, data.layout || null,
            data.preference || null, plan.date, plan.end_date, plan.start_time, plan.end_time, plan.starts_at, plan.ends_at,
            plan.hold_start, plan.hold_end, status, !option, data.notes, data.channel, data.idempotency_key, command.correlation_id,
            actor?.userId || null, status === 'checked_in' ? new Date() : null, ...quoteColumns(quote)])).rows[0];

        if (status === 'checked_in') {
          await db.query(
            `UPDATE resources SET operational_status = 'in_use', operational_updated_at = NOW(), operational_updated_by = $2 WHERE id = $1`,
            [option.resource.id, actor?.userId || null]);
          await db.query(
            `INSERT INTO operational_events (business_id, resource_id, booking_id, action, from_status, to_status, actor_user_id, actor_label)
             VALUES ($1, $2, $3, 'walk_in', $4, 'in_use', $5, $6)`,
            [business.id, option.resource.id, row.id, option.resource.operational_status, actor?.userId || null, actor?.email || actor?.label || '']);
        }
        await finishCommand(db, command.id, { status: 'succeeded', bookingId: row.id, result: { booking_id: row.id } });
        const reservation = await fetchReservation(db, business.id, row.id);
        await recordAudit(db, { businessId: business.id, actor, action: option ? 'create' : 'waitlist', entity: 'booking', entityId: row.id,
          after: auditView(reservation) });
        return { reservation, idempotent_replay: false, events: [option ? 'created' : 'waitlisted'] };
      });
    } catch (err) {
      throw mapConstraint(err);
    }
  },

  async modifyReservation(business, bookingId, changes, options, actor) {
    try {
      return await withTransaction(async (db) => {
        const row = (await db.query('SELECT * FROM bookings WHERE id = $1 AND business_id = $2 FOR UPDATE', [bookingId, business.id])).rows[0];
        if (!row) throw notFound('Reservation not found.');
        if (!ACTIVE.includes(row.status)) throw validationError('That reservation is no longer active.', { reason: 'not_active' });

        const current = { date: toDateKey(row.date), end_date: toDateKey(row.end_date),
          start_time: String(row.start_time || '').slice(0, 5) || undefined, end_time: String(row.end_time || '').slice(0, 5) || undefined,
          people: row.people, resource_id: row.resource_id ? Number(row.resource_id) : null,
          resource_type_id: row.resource_type_id ? Number(row.resource_type_id) : null, layout: row.layout || undefined };
        const scheduleChanged = SCHEDULE_FIELDS.some((field) => field in changes && String(changes[field] ?? '') !== String(current[field] ?? ''));
        const next = { ...current, ...Object.fromEntries(SCHEDULE_FIELDS.filter((field) => field in changes).map((field) => [field, changes[field]])) };

        // Moving the start keeps the original length (nights or minutes) unless
        // the caller also supplies a new end.
        if (row.starts_at && row.ends_at) {
          if (row.service_type === 'hotel' && 'date' in changes && !('end_date' in changes) && current.end_date) {
            next.end_date = addDays(next.date, diffDays(current.date, current.end_date));
          }
          if (row.service_type !== 'hotel' && 'start_time' in changes && !('end_time' in changes)) {
            const minutes = Math.round((row.ends_at - row.starts_at) / 60000);
            next.end_time = formatMinutes(parseTime(next.start_time) + minutes);
          }
        }

        if ('date' in changes && changes.date !== current.date && changes.date < todayKey(business.timezone)) {
          throw validationError('That date has already passed. Which date would you like instead?', { field: 'date', reason: 'past' });
        }

        let assignment = {};
        let quote = row.quote;
        if (scheduleChanged) {
          if (row.status === 'checked_in' && ['date', 'start_time', 'resource_id'].some((field) => field in changes
            && String(changes[field] ?? '') !== String(current[field] ?? ''))) {
            throw validationError('A stay or sitting that has started can only be extended, shortened, or resized.');
          }
          const ctx = await loadContext(db, business, row.service_type, { lock: true });
          assertInternal(ctx);
          const request = { service_type: row.service_type, date: next.date, end_date: next.end_date || undefined,
            start_time: next.start_time, end_time: next.end_time, people: next.people, layout: next.layout,
            exclude_booking_id: row.id };
          if (row.service_type !== 'hotel' && 'end_date' in changes) {
            throw validationError('This reservation uses a single date.', { field: 'end_date' });
          }
          if (row.waitlisted) {
            // A waitlist entry never claims inventory, whatever it is changed to.
            const plan = servicePlan(ctx, request);
            assignment = { plan, resource_id: null, resource_type_id: next.resource_type_id, hold: false };
          } else {
            const explicit = 'resource_id' in changes && changes.resource_id !== current.resource_id;
            const wanted = explicit ? changes.resource_id : current.resource_id;
            let result = await evaluate(db, ctx, { ...request, ...(wanted ? { resource_id: wanted } : {
              resource_type_id: 'resource_type_id' in changes ? changes.resource_type_id : undefined,
              preference: row.preferred_inventory || undefined }) });
            if (!result.selected && wanted && !explicit && options.allow_reassign) {
              result = await evaluate(db, ctx, { ...request, resource_type_id: current.resource_type_id || undefined });
              if (!result.selected) result = await evaluate(db, ctx, request);
            }
            if (!result.selected) {
              const base = unavailable(result);
              throw new BookingError('conflict', wanted && !explicit && result.reason.code === 'full'
                ? 'Your current room or table is unavailable for those details. The reservation was not changed.' : base.message,
              { ...base.details, unchanged: true });
            }
            const option = result.selected;
            quote = buildQuote(ctx, option, request);
            const priced = Number(quote.total) > 0 || quote.deposit.required || Number(quote.minimum_spend) > 0;
            const termsChanged = row.quote ? row.quote.hash !== quote.hash : priced;
            if (termsChanged && !options.accept_requote && options.accepted_quote_hash !== quote.hash) {
              throw new BookingError('quote_changed', 'The price or booking terms would change. Please confirm the new terms.',
                { quote, previous_quote: row.quote, unchanged: true });
            }
            assignment = { plan: option.plan, resource_id: option.resource.id, resource_type_id: option.resource.type_id, hold: true };
          }
        }

        const plan = assignment.plan;
        const updated = (await db.query(
          `UPDATE bookings SET
             reservation_name = $3, contact_phone = $4, contact_email = $5, notes = $6, people = $7, layout = $8,
             date = COALESCE($9, date), end_date = CASE WHEN $10 THEN $11 ELSE end_date END,
             start_time = COALESCE($12, start_time), end_time = COALESCE($13, end_time),
             starts_at = COALESCE($14, starts_at), ends_at = COALESCE($15, ends_at),
             hold_period = CASE WHEN NOT $10 THEN hold_period WHEN $16 THEN tstzrange($17, $18, '[)') ELSE NULL END,
             resource_id = CASE WHEN $10 THEN $19 ELSE resource_id END,
             resource_type_id = CASE WHEN $10 THEN $20 ELSE resource_type_id END,
             quote = $21::jsonb, currency = COALESCE($22, currency), total_amount = COALESCE($23, total_amount),
             booking_fee_amount = COALESCE($24, booking_fee_amount), min_spend_amount = COALESCE($25, min_spend_amount),
             deposit_amount = COALESCE($26, deposit_amount),
             deposit_status = CASE WHEN $10 AND deposit_status IN ('not_required', 'due') THEN $27 ELSE deposit_status END,
             status = CASE WHEN status = 'confirmed' THEN 'modified' ELSE status END,
             legacy_review = CASE WHEN $10 AND $16 THEN FALSE ELSE legacy_review END,
             review_reason = CASE WHEN $10 AND $16 THEN NULL ELSE review_reason END,
             calendar_sync_status = 'pending', updated_at = NOW()
           WHERE id = $1 AND business_id = $2 RETURNING id`,
          [row.id, business.id, changes.reservation_name ?? row.reservation_name, changes.contact_phone ?? row.contact_phone,
            'contact_email' in changes ? (changes.contact_email || null) : row.contact_email, changes.notes ?? row.notes,
            next.people, next.layout || null, plan?.date || null, Boolean(plan), plan?.end_date || null,
            plan?.start_time || null, plan?.end_time || null, plan?.starts_at || null, plan?.ends_at || null,
            Boolean(assignment.hold), plan?.hold_start || null, plan?.hold_end || null,
            assignment.resource_id || null, assignment.resource_type_id || null,
            quote ? JSON.stringify(quote) : null, quote?.currency || null, quote?.total ?? null, quote?.booking_fee ?? null,
            quote?.minimum_spend ?? null, quote?.deposit.amount ?? null, quote?.deposit.required ? 'due' : 'not_required'])).rows[0];

        const reservation = await fetchReservation(db, business.id, updated.id);
        await recordAudit(db, { businessId: business.id, actor, action: 'update', entity: 'booking', entityId: row.id,
          before: auditView(await shapeBefore(row)), after: auditView(reservation) });
        return { reservation, events: ['modified'], schedule_changed: scheduleChanged,
          freed: scheduleChanged && row.hold_period ? { service_type: row.service_type } : null };
      });
    } catch (err) {
      throw mapConstraint(err);
    }
  },

  async cancelReservation(business, bookingId, { reason = '' } = {}, actor) {
    return withTransaction(async (db) => {
      const row = (await db.query('SELECT * FROM bookings WHERE id = $1 AND business_id = $2 FOR UPDATE', [bookingId, business.id])).rows[0];
      if (!row) throw notFound('Reservation not found.');
      if (row.status === 'cancelled') return { reservation: await fetchReservation(db, business.id, row.id), idempotent_replay: true, events: [] };
      if (row.status === 'checked_in') throw validationError('This guest has already arrived. Check out or finish the sitting instead of cancelling.');
      if (!['pending', 'confirmed', 'modified', 'awaiting_confirmation'].includes(row.status)) {
        throw validationError('That reservation is no longer active.', { reason: 'not_active' });
      }
      await db.query(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $3, calendar_sync_status = 'pending', updated_at = NOW()
         WHERE id = $1 AND business_id = $2`, [row.id, business.id, reason]);
      const reservation = await fetchReservation(db, business.id, row.id);
      await recordAudit(db, { businessId: business.id, actor, action: 'cancel', entity: 'booking', entityId: row.id,
        before: { status: row.status }, after: { status: 'cancelled', reason } });
      return { reservation, idempotent_replay: false, events: ['cancelled'], freed: { service_type: row.service_type } };
    });
  },

  /** Move one waitlisted request into real inventory, if its FULL requirements now fit. */
  async promoteWaitlisted(business, bookingId) {
    try {
      return await withTransaction(async (db) => {
        const row = (await db.query(
          `SELECT * FROM bookings WHERE id = $1 AND business_id = $2 AND waitlisted = TRUE AND status = 'pending' FOR UPDATE`,
          [bookingId, business.id])).rows[0];
        if (!row) return null;
        const ctx = await loadContext(db, business, row.service_type, { lock: true });
        if (ctx.service.booking_source !== 'internal') return null;
        const request = { service_type: row.service_type, date: toDateKey(row.date), end_date: toDateKey(row.end_date) || undefined,
          start_time: String(row.start_time || '').slice(0, 5) || undefined, end_time: String(row.end_time || '').slice(0, 5) || undefined,
          people: row.people || 1, layout: row.layout || undefined, preference: row.preferred_inventory || undefined,
          resource_type_id: row.resource_type_id ? Number(row.resource_type_id) : undefined, exclude_booking_id: row.id };
        let result;
        try { result = await evaluate(db, ctx, request); } catch (err) { if (err instanceof BookingError) return null; throw err; }
        const option = result.selected;
        if (!option) return null;
        const quote = buildQuote(ctx, option, request);
        await db.query(
          `UPDATE bookings SET waitlisted = FALSE, status = 'confirmed', resource_id = $3, resource_type_id = $4,
             start_time = $5, end_time = $6, starts_at = $7, ends_at = $8, hold_period = tstzrange($9, $10, '[)'),
             quote = $11::jsonb, currency = $12, total_amount = $13, booking_fee_amount = $14, min_spend_amount = $15,
             deposit_amount = $16, deposit_status = $17, calendar_sync_status = 'pending', updated_at = NOW()
           WHERE id = $1 AND business_id = $2`,
          [row.id, business.id, option.resource.id, option.resource.type_id, option.plan.start_time, option.plan.end_time,
            option.plan.starts_at, option.plan.ends_at, option.plan.hold_start, option.plan.hold_end, ...quoteColumns(quote)]);
        const reservation = await fetchReservation(db, business.id, row.id);
        await recordAudit(db, { businessId: business.id, actor: { label: 'waitlist' }, action: 'promote', entity: 'booking', entityId: row.id,
          before: { waitlisted: true }, after: auditView(reservation) });
        return { reservation, events: ['promoted'] };
      });
    } catch (err) {
      if (err?.code === '23P01') return null;
      throw err;
    }
  },
};

async function shapeBefore(row) {
  return { status: row.status, date: toDateKey(row.date), end_date: toDateKey(row.end_date), start_time: row.start_time,
    end_time: row.end_time, people: row.people, reservation_name: row.reservation_name, contact_phone: row.contact_phone,
    notes: row.notes, resource: row.resource_id ? { id: Number(row.resource_id) } : null, total_amount: row.total_amount };
}

function auditView(reservation) {
  if (!reservation) return {};
  return { status: reservation.status, waitlisted: reservation.waitlisted, date: reservation.date, end_date: reservation.end_date,
    start_time: reservation.start_time, end_time: reservation.end_time, people: reservation.people,
    reservation_name: reservation.reservation_name, contact_phone: reservation.contact_phone, notes: reservation.notes,
    resource: reservation.resource?.code ?? (reservation.resource?.id ? `#${reservation.resource.id}` : ''),
    total_amount: reservation.total_amount };
}
