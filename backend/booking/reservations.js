// Reading reservations and the one shape every API returns them in.
import crypto from 'node:crypto';
import { query } from '../services/db.js';
import { BookingError } from '../platform/errors.js';
import { toDateKey } from '../platform/time.js';

export const RESERVATION_SELECT = `
  SELECT b.*, lower(b.hold_period) AS hold_start, upper(b.hold_period) AS hold_end,
         r.code AS resource_code, r.name AS resource_name, r.operational_status AS resource_operational_status,
         t.name AS resource_type_name
  FROM bookings b
  LEFT JOIN resources r ON r.id = b.resource_id
  LEFT JOIN resource_types t ON t.id = b.resource_type_id`;

const amount = (value) => (value === null || value === undefined ? null : String(Number(value)));

/** One reservation, with reservation status, sync status and operational
 * status kept as three separate fields. */
export function shapeReservation(row) {
  if (!row) return null;
  const displayStatus = row.waitlisted && row.status === 'pending' ? 'waitlisted'
    : row.status === 'awaiting_confirmation' ? 'awaiting_confirmation'
      : row.attention_reason ? 'needs_attention' : row.status;
  return {
    id: row.id,
    business_id: Number(row.business_id),
    service_type: row.service_type,
    status: row.status,
    display_status: displayStatus,
    waitlisted: row.waitlisted,
    date: toDateKey(row.date), end_date: toDateKey(row.end_date),
    start_time: row.start_time, end_time: row.end_time,
    starts_at: row.starts_at, ends_at: row.ends_at,
    people: row.people, layout: row.layout,
    reservation_name: row.reservation_name, contact_phone: row.contact_phone, contact_email: row.contact_email,
    notes: row.notes || '',
    // A physical room/table is reported only when one is really assigned.
    resource: row.resource_id ? { id: Number(row.resource_id), code: row.resource_code, name: row.resource_name,
      operational_status: row.resource_operational_status } : null,
    resource_type: row.resource_type_id ? { id: Number(row.resource_type_id), name: row.resource_type_name } : null,
    source: row.source, channel: row.channel,
    external_reservation_id: row.external_reservation_id, correlation_id: row.correlation_id,
    sync_status: row.sync_status, sync_checked_at: row.sync_checked_at, attention_reason: row.attention_reason,
    calendar_sync_status: row.calendar_sync_status, google_event_id: row.google_event_id,
    quote: row.quote, currency: row.currency,
    total_amount: amount(row.total_amount), booking_fee_amount: amount(row.booking_fee_amount),
    min_spend_amount: amount(row.min_spend_amount),
    deposit: { amount: amount(row.deposit_amount), status: row.deposit_status, recorded_at: row.deposit_recorded_at },
    service_started_at: row.service_started_at, service_ended_at: row.service_ended_at,
    cancelled_at: row.cancelled_at, cancel_reason: row.cancel_reason,
    review_reason: row.review_reason, legacy_review: row.legacy_review,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

export async function fetchReservation(db, businessId, bookingId) {
  const run = db ? db.query.bind(db) : query;
  const id = Number(bookingId);
  if (!Number.isInteger(id) || id < 1) return null;
  // Always scoped by business: an ID from another business finds nothing.
  return shapeReservation((await run(`${RESERVATION_SELECT} WHERE b.id = $1 AND b.business_id = $2`, [id, businessId])).rows[0]);
}

export async function listReservations(businessId, filters = {}) {
  const clauses = ['b.business_id = $1'];
  const values = [businessId];
  const add = (sql, value) => { values.push(value); clauses.push(sql.replace('?', `$${values.length}`)); };
  if (filters.service_type) add('b.service_type = ?', filters.service_type);
  if (filters.status === 'waitlisted') clauses.push(`b.waitlisted = TRUE AND b.status = 'pending'`);
  else if (filters.status === 'needs_attention') clauses.push(`(b.attention_reason IS NOT NULL OR b.review_reason IS NOT NULL OR b.status = 'awaiting_confirmation')`);
  else if (filters.status) add('b.status = ?', filters.status);
  if (filters.from) add('b.ends_at >= ?', filters.from);
  if (filters.to) add('b.starts_at < ?', filters.to);
  if (filters.session_id) add('b.session_id = ?', filters.session_id);
  if (filters.search) add(`(b.reservation_name ILIKE '%' || ? || '%' OR b.contact_phone ILIKE '%' || $${values.length + 1} || '%')`, filters.search);
  values.push(Math.min(Math.max(Number(filters.limit) || 100, 1), 500));
  const rows = (await query(
    `${RESERVATION_SELECT} WHERE ${clauses.join(' AND ')}
     ORDER BY ${filters.order === 'schedule' ? 'b.starts_at ASC NULLS LAST, b.id' : 'b.created_at DESC, b.id DESC'} LIMIT $${values.length}`, values)).rows;
  return rows.map(shapeReservation);
}

export function requestHash(data) {
  const { idempotency_key, ...rest } = data;
  const stable = (value) => (value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value);
  return crypto.createHash('sha256').update(JSON.stringify(stable(rest))).digest('hex');
}

/**
 * Register a booking command under its idempotency key.
 * A retry (or double-click) finds the original command instead of running again.
 */
export async function beginCommand(db, businessId, { key, command, serviceType, provider = 'internal', hash }) {
  const inserted = (await db.query(
    `INSERT INTO booking_commands (business_id, idempotency_key, command, service_type, provider, request_hash, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (business_id, idempotency_key) DO NOTHING RETURNING *`,
    [businessId, key, command, serviceType, provider, hash, crypto.randomUUID()])).rows[0];
  if (inserted) return { command: inserted, fresh: true };
  const existing = (await db.query(
    'SELECT * FROM booking_commands WHERE business_id = $1 AND idempotency_key = $2 FOR UPDATE', [businessId, key])).rows[0];
  if (existing.request_hash !== hash || existing.command !== command) {
    throw new BookingError('idempotency_conflict', 'This request key was already used for a different booking request.');
  }
  return { command: existing, fresh: false };
}

export async function finishCommand(db, commandId, { status, bookingId = null, result = null, error = null }) {
  await db.query(
    `UPDATE booking_commands SET status = $2, booking_id = COALESCE($3, booking_id), result = $4::jsonb, error = $5::jsonb WHERE id = $1`,
    [commandId, status, bookingId, result ? JSON.stringify(result) : null, error ? JSON.stringify(error) : null]);
}

export async function upsertCustomer(db, businessId, customer) {
  if (!customer?.phone) return null;
  return (await db.query(
    `INSERT INTO customers (business_id, phone_number, name, email) VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id, phone_number)
     DO UPDATE SET name = COALESCE(customers.name, EXCLUDED.name), email = COALESCE(EXCLUDED.email, customers.email), updated_at = NOW()
     RETURNING id`, [businessId, customer.phone, customer.name, customer.email || null])).rows[0].id;
}
