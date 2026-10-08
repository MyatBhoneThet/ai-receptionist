// Availability and pricing rules for internally managed services.
// Availability is always computed for the requested interval — a resource has
// no permanent free/busy flag.
import crypto from 'node:crypto';
import { resolveConfig, capacityOf } from '../platform/config.js';
import { BookingError, validationError } from '../platform/errors.js';
import { toMinor, fromMinor, scaleMinor } from '../platform/money.js';
import { zonedToInstant, addDays, diffDays, parseTime, formatMinutes, weekdayOf, zonedParts, todayKey } from '../platform/time.js';
import { HOLDING_STATUSES } from '../platform/businesses.js';

const MINUTE = 60000;

/**
 * Service, policies and physical resources for one business + service.
 * With `lock`, the resource rows are locked (in id order) for the rest of the
 * transaction so the availability decision and the write that follows are atomic.
 */
export async function loadContext(db, business, serviceType, { lock = false } = {}) {
  const service = (await db.query(
    'SELECT * FROM business_services WHERE business_id = $1 AND service_type = $2', [business.id, serviceType])).rows[0];
  if (!service || !service.enabled) {
    throw validationError(`${serviceType} bookings are not offered by this business.`, { reason: 'service_not_enabled' });
  }
  if (lock) {
    await db.query(
      'SELECT id FROM resources WHERE business_id = $1 AND service_type = $2 AND archived_at IS NULL ORDER BY id FOR UPDATE',
      [business.id, serviceType]);
  }
  const rows = (await db.query(
    `SELECT r.*, t.name AS type_name, t.defaults AS type_defaults, t.is_active AS type_active
     FROM resources r JOIN resource_types t ON t.id = r.resource_type_id
     WHERE r.business_id = $1 AND r.service_type = $2 AND r.archived_at IS NULL AND t.archived_at IS NULL
     ORDER BY r.id`, [business.id, serviceType])).rows;
  const closures = (await db.query(
    `SELECT start_date::text, end_date::text, reason FROM closures
     WHERE business_id = $1 AND (service_type IS NULL OR service_type = $2)`, [business.id, serviceType])).rows;
  return {
    business, service, serviceType, closures,
    resources: rows.map((row) => ({
      id: Number(row.id), code: row.code, name: row.name, type_id: Number(row.resource_type_id), type_name: row.type_name,
      active: row.is_active && row.type_active, operational_status: row.operational_status,
      config: resolveConfig(serviceType, service.settings, row.type_defaults, row.overrides).values,
    })),
  };
}

function withinOperatingHours(hours, dateKey, start, end, timeZone) {
  if (!hours) return true;
  // A period that opened yesterday may still be running past midnight.
  for (const day of [addDays(dateKey, -1), dateKey]) {
    for (const period of hours[weekdayOf(day)] || []) {
      const open = parseTime(period.open);
      const close = parseTime(period.close);
      const opensAt = zonedToInstant(day, open, timeZone).instant;
      const closesAt = zonedToInstant(close <= open ? addDays(day, 1) : day, close, timeZone).instant;
      if (start >= opensAt && end <= closesAt) return true;
    }
  }
  return false;
}

const isClosed = (closures, from, to) => closures.find((closure) => closure.start_date <= to && closure.end_date >= from);

/**
 * Turn a request into concrete instants under one resource's policies.
 * Returns { plan } or { rule, message } when that resource's rules reject it.
 * Throws only for requests that are malformed for every resource.
 */
export function planInterval(ctx, config, request) {
  const { timeZone } = { timeZone: ctx.business.timezone };
  // New requests cannot start on a business-local date that has already passed.
  if (!request.exclude_booking_id && !request.allow_past && request.date < todayKey(timeZone)) {
    throw validationError('That date has already passed. Which date would you like instead?', { field: 'date', reason: 'past' });
  }
  if (ctx.serviceType === 'hotel') {
    if (!request.end_date) throw validationError('A check-out date is required.', { field: 'end_date' });
    const nights = diffDays(request.date, request.end_date);
    if (nights < 1) throw validationError('The check-out date must be after the check-in date.', { field: 'end_date' });
    if (nights < config.min_stay_nights) {
      return { rule: 'min_stay', message: `The minimum stay is ${config.min_stay_nights} night(s).` };
    }
    const closed = isClosed(ctx.closures, request.date, addDays(request.end_date, -1));
    if (closed) return { rule: 'closed', message: `Closed ${closed.start_date} to ${closed.end_date}${closed.reason ? ` (${closed.reason})` : ''}.` };
    // Check-in and check-out stay property-local calendar dates. The stay ends
    // at check-out time, so the next guest can arrive that same day.
    const startsAt = zonedToInstant(request.date, parseTime(config.check_in_time), timeZone).instant;
    const endsAt = zonedToInstant(request.end_date, parseTime(config.check_out_time), timeZone).instant;
    return { plan: { date: request.date, end_date: request.end_date, start_time: config.check_in_time, end_time: config.check_out_time,
      starts_at: startsAt, ends_at: endsAt, hold_start: startsAt, hold_end: endsAt, nights, minutes: null } };
  }

  const startMinutes = parseTime(request.start_time);
  if (startMinutes === null) throw validationError('A start time is required.', { field: 'start_time' });
  const start = zonedToInstant(request.date, startMinutes, timeZone);
  if (!start.valid) {
    throw validationError(`${request.start_time} does not exist on ${request.date} because the clocks change.`, { field: 'start_time' });
  }
  if (!request.exclude_booking_id && !request.allow_past && !request.immediate && start.instant.getTime() < Date.now() - 5 * MINUTE) {
    throw validationError('That time has already passed. What time would you like instead?', { field: 'start_time', reason: 'past' });
  }
  let endMinutes = request.end_time ? parseTime(request.end_time) : null;
  let endDate = request.date;
  let end;
  if (endMinutes === null) {
    const length = ctx.serviceType === 'restaurant' ? config.default_duration_minutes : config.min_duration_minutes;
    // Elapsed minutes, so a sitting spanning a clock change keeps its real length.
    end = { instant: new Date(start.instant.getTime() + length * MINUTE), valid: true };
    const local = zonedParts(end.instant, timeZone);
    endDate = local.date;
    endMinutes = local.minutes;
  } else {
    if (endMinutes <= startMinutes) endDate = addDays(request.date, 1);   // runs past midnight
    end = zonedToInstant(endDate, endMinutes, timeZone);
    if (!end.valid) throw validationError(`${request.end_time} does not exist on ${endDate} because the clocks change.`, { field: 'end_time' });
  }
  const minutes = Math.round((end.instant - start.instant) / MINUTE);
  if (minutes <= 0) throw validationError('The end time must be after the start time.', { field: 'end_time' });
  if (minutes > 1440) throw validationError('A single reservation cannot be longer than 24 hours.', { field: 'end_time' });

  const closed = isClosed(ctx.closures, request.date, request.date);
  if (closed) return { rule: 'closed', message: `Closed on ${request.date}${closed.reason ? ` (${closed.reason})` : ''}.` };
  if (!withinOperatingHours(config.operating_hours, request.date, start.instant, end.instant, timeZone)) {
    return { rule: 'outside_hours', message: 'That time is outside operating hours.' };
  }

  let before = 0;
  let after = 0;
  if (ctx.serviceType === 'meeting') {
    if (minutes < config.min_duration_minutes) {
      return { rule: 'min_duration', message: `The minimum booking is ${config.min_duration_minutes} minutes.` };
    }
    if (minutes % config.increment_minutes !== 0 || startMinutes % config.increment_minutes !== 0) {
      return { rule: 'increment', message: `Bookings start and end on ${config.increment_minutes}-minute steps.` };
    }
    before = config.setup_buffer_minutes;
    after = config.cleanup_buffer_minutes;
  } else {
    if (minutes < 15) return { rule: 'min_duration', message: 'A table reservation is at least 15 minutes.' };
    after = config.turnover_buffer_minutes;
  }
  return { plan: { date: request.date, end_date: null, start_time: formatMinutes(startMinutes), end_time: formatMinutes(endMinutes),
    starts_at: start.instant, ends_at: end.instant,
    hold_start: new Date(start.instant.getTime() - before * MINUTE), hold_end: new Date(end.instant.getTime() + after * MINUTE),
    nights: null, minutes } };
}

function preferenceTokens(text) {
  const synonyms = { high: 'suite', higher: 'suite', highest: 'suite', luxury: 'suite', premium: 'suite' };
  const tokens = String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    .filter((token) => !['room', 'rooms', 'table', 'tables', 'a', 'the', 'type'].includes(token))
    .map((token) => synonyms[token] || token);
  return [...new Set(tokens)];
}

function matchesPreference(resource, tokens) {
  if (!tokens.length) return true;
  const config = resource.config;
  const haystack = [resource.code, resource.name, resource.type_name, config.seating_area, config.bed_configuration,
    ...(config.amenities || []), ...(config.equipment || []), ...(config.layouts || []).map((item) => item.name)]
    .filter(Boolean).join(' ').toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Evaluate every resource against the request. Each option carries the reason
 * it is unavailable, so callers can explain and offer alternatives.
 */
export async function evaluate(db, ctx, request) {
  const tokens = preferenceTokens(request.preference);
  const options = [];
  for (const resource of ctx.resources) {
    const option = { resource, capacity: capacityOf(ctx.serviceType, resource.config, request.layout), available: false,
      reason: null, message: null, plan: null, preferred: matchesPreference(resource, tokens) };
    if (request.resource_id && resource.id !== request.resource_id) continue;
    if (request.resource_type_id && resource.type_id !== request.resource_type_id) { option.reason = 'type_mismatch'; options.push(option); continue; }
    if (!resource.active) { option.reason = 'inactive'; options.push(option); continue; }
    if (request.layout && option.capacity === 0) { option.reason = 'layout_unavailable'; options.push(option); continue; }
    if (option.capacity < request.people) { option.reason = 'capacity'; options.push(option); continue; }
    const planned = planInterval(ctx, resource.config, request);
    if (!planned.plan) { option.reason = planned.rule; option.message = planned.message; options.push(option); continue; }
    option.plan = planned.plan;
    options.push(option);
  }

  const planned = options.filter((option) => option.plan);
  if (planned.length) {
    const ids = planned.map((option) => option.resource.id);
    const from = new Date(Math.min(...planned.map((option) => option.plan.hold_start.getTime())));
    const to = new Date(Math.max(...planned.map((option) => option.plan.hold_end.getTime())));
    const booked = (await db.query(
      `SELECT id, resource_id, lower(hold_period) AS hold_start, upper(hold_period) AS hold_end FROM bookings
       WHERE business_id = $1 AND resource_id = ANY($2::bigint[]) AND waitlisted = FALSE
         AND status = ANY($3::text[]) AND hold_period && tstzrange($4, $5, '[)')
         AND ($6::int IS NULL OR id <> $6)`,
      [ctx.business.id, ids, HOLDING_STATUSES, from, to, request.exclude_booking_id || null])).rows;
    const blocked = (await db.query(
      `SELECT resource_id, lower(period) AS hold_start, upper(period) AS hold_end, reason FROM maintenance_blocks
       WHERE business_id = $1 AND resource_id = ANY($2::bigint[]) AND removed_at IS NULL AND period && tstzrange($3, $4, '[)')`,
      [ctx.business.id, ids, from, to])).rows;
    const overlaps = (rows, option) => rows.find((row) => Number(row.resource_id) === option.resource.id
      && row.hold_start < option.plan.hold_end && row.hold_end > option.plan.hold_start);
    for (const option of planned) {
      const maintenance = overlaps(blocked, option);
      const reservation = overlaps(booked, option);
      if (maintenance) { option.reason = 'maintenance'; option.message = maintenance.reason || 'Under maintenance.'; }
      else if (reservation) { option.reason = 'booked'; option.conflicting_booking_id = reservation.id; }
      // Cleaning or current occupancy only matters for use right now; it
      // never blocks a future date.
      else if (request.immediate && resource_not_ready(option.resource)) { option.reason = 'not_ready'; option.message = `Currently ${option.resource.operational_status.replace(/_/g, ' ')}.`; }
      else option.available = true;
    }
  }

  options.sort((a, b) => Number(b.available) - Number(a.available) || Number(b.preferred) - Number(a.preferred)
    || a.capacity - b.capacity || naturalCompare(a.resource.code, b.resource.code));
  const preferredAvailable = options.filter((option) => option.available && option.preferred);
  const anyAvailable = options.filter((option) => option.available);
  const selected = (tokens.length ? preferredAvailable[0] : anyAvailable[0]) || null;
  return { options, selected, available: (tokens.length ? preferredAvailable : anyAvailable).length,
    other_available: tokens.length ? anyAvailable.filter((option) => !option.preferred) : [],
    reason: selected ? 'available' : summarizeReason(options, tokens) };
}

const resource_not_ready = (resource) => resource.operational_status !== 'ready';

function summarizeReason(options, tokens) {
  if (!options.length) return { code: 'no_inventory', message: 'No rooms or tables are set up for this service.' };
  const pool = tokens.length && options.some((option) => option.preferred) ? options.filter((option) => option.preferred) : options;
  if (tokens.length && !options.some((option) => option.preferred)) {
    return { code: 'requested_type_not_found', message: 'Nothing matches that request.' };
  }
  const reasons = pool.map((option) => option.reason);
  // Explain the most actionable cause: if anything was merely booked, say "full".
  for (const code of ['booked', 'maintenance', 'not_ready']) {
    if (reasons.includes(code)) return { code: code === 'booked' ? 'full' : code, message: pool.find((option) => option.reason === code).message || 'Fully booked for that time.' };
  }
  for (const code of ['min_stay', 'min_duration', 'increment', 'outside_hours', 'closed']) {
    if (reasons.includes(code)) return { code, message: pool.find((option) => option.reason === code).message };
  }
  if (reasons.every((code) => code === 'capacity' || code === 'layout_unavailable' || code === 'type_mismatch')) {
    return { code: 'capacity', message: 'No single room or table is large enough for that party.' };
  }
  return { code: 'unavailable', message: 'Nothing is available for that request.' };
}

/** Price and policies for one option. Stored with the reservation when accepted. */
export function buildQuote(ctx, option, request) {
  const currency = ctx.business.currency;
  if (!currency) throw new BookingError('activation_blocked', 'The business currency has not been confirmed.');
  const { config } = option.resource;
  const { plan } = option;
  const lines = [];
  let policies;
  let minSpend = 0;
  if (ctx.serviceType === 'hotel') {
    const rate = toMinor(config.base_rate, currency);
    lines.push({ code: 'accommodation', label: `${option.resource.type_name} × ${plan.nights} night(s)`,
      unit_amount: fromMinor(rate, currency), quantity: plan.nights, amount: fromMinor(rate * plan.nights, currency) });
    policies = { check_in_time: config.check_in_time, check_out_time: config.check_out_time, min_stay_nights: config.min_stay_nights,
      max_guests: config.max_guests };
  } else if (ctx.serviceType === 'meeting') {
    const rate = toMinor(config.base_rate, currency);
    const amount = config.rate_unit === 'daily' ? rate : scaleMinor(rate, plan.minutes, 60);
    lines.push({ code: 'room_hire', label: config.rate_unit === 'daily' ? `${option.resource.type_name} day rate`
      : `${option.resource.type_name} × ${plan.minutes / 60} hour(s)`,
      unit_amount: fromMinor(rate, currency), quantity: config.rate_unit === 'daily' ? 1 : plan.minutes / 60, amount: fromMinor(amount, currency) });
    policies = { rate_unit: config.rate_unit, min_duration_minutes: config.min_duration_minutes, increment_minutes: config.increment_minutes,
      setup_buffer_minutes: config.setup_buffer_minutes, cleanup_buffer_minutes: config.cleanup_buffer_minutes,
      layout: request.layout || null, capacity: option.capacity };
  } else {
    minSpend = toMinor(config.min_spend, currency);
    policies = { duration_minutes: plan.minutes, seating_area: config.seating_area, seating_capacity: config.seating_capacity };
  }
  const subtotal = lines.reduce((sum, line) => sum + toMinor(line.amount, currency), 0);
  const fee = toMinor(config.booking_fee, currency);
  const total = subtotal + fee;
  const rule = config.deposit || { type: 'none' };
  const deposit = rule.type === 'fixed' ? toMinor(rule.amount, currency)
    : rule.type === 'per_guest' ? toMinor(rule.amount, currency) * request.people
      : rule.type === 'percent' ? scaleMinor(total, Math.round(rule.percent * 100), 10000) : 0;

  // Three separate concepts: what is charged (total, incl. booking fee), what
  // must be put down in advance (deposit), and a spending commitment (min spend).
  const quote = {
    currency,
    lines,
    subtotal: fromMinor(subtotal, currency),
    booking_fee: fromMinor(fee, currency),
    total: fromMinor(total, currency),
    minimum_spend: fromMinor(minSpend, currency),
    deposit: { required: deposit > 0, amount: fromMinor(deposit, currency), rule,
      collection: 'Recorded by staff. No payment is taken online.' },
    policies,
    resource_type: { id: option.resource.type_id, name: option.resource.type_name },
  };
  quote.hash = quoteHash(quote);
  return quote;
}

export function quoteHash(quote) {
  const { hash, lines, ...terms } = quote;
  return crypto.createHash('sha256').update(JSON.stringify({ ...terms, lines: lines.map((line) => [line.code, line.amount]) })).digest('hex').slice(0, 32);
}

/** Human-readable terms the receptionist must disclose before confirmation. */
export function describeQuote(quote) {
  if (!quote) return '';
  const money = (amount) => `${amount} ${quote.currency}`;
  const parts = [];
  if (Number(quote.total) > 0) parts.push(`The total is ${money(quote.total)}${Number(quote.booking_fee) > 0 ? `, including a ${money(quote.booking_fee)} booking fee` : ''}.`);
  if (Number(quote.minimum_spend) > 0) parts.push(`This table has a minimum spend of ${money(quote.minimum_spend)}.`);
  if (quote.deposit?.required) parts.push(`A deposit of ${money(quote.deposit.amount)} is required; our staff will arrange it with you — nothing is charged now.`);
  const policy = quote.policies || {};
  if (policy.check_in_time) parts.push(`Check-in is from ${policy.check_in_time} and check-out by ${policy.check_out_time}.`);
  if (policy.duration_minutes && !policy.check_in_time) parts.push(`The table is yours for ${policy.duration_minutes} minutes.`);
  return parts.join(' ');
}
