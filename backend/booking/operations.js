// Daily operations for internally managed services. Operational status (the
// real-world state of a room or table) is tracked separately from the
// reservation status, and every change records who made it and when.
import { z } from 'zod';
import { query, withTransaction } from '../services/db.js';
import { BookingError, notFound, validationError } from '../platform/errors.js';
import { HOLDING_STATUSES } from '../platform/businesses.js';
import { localDayBounds, todayKey, zonedParts, isDateKey } from '../platform/time.js';
import { fetchReservation, shapeReservation, RESERVATION_SELECT } from './reservations.js';

const ARRIVE = { hotel: 'check_in', restaurant: 'seat', meeting: 'start' };
const FINISH = { hotel: 'check_out', restaurant: 'finish', meeting: 'complete' };
const LABEL = { ready: 'ready', in_use: 'in use', needs_cleaning: 'waiting to be cleaned', out_of_service: 'out of service' };
const SOON_MINUTES = 30;

export const BOOKING_ACTIONS = ['check_in', 'seat', 'start', 'check_out', 'finish', 'complete', 'no_show'];
export const RESOURCE_ACTIONS = ['mark_ready', 'mark_needs_cleaning', 'mark_out_of_service'];

export const operationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(BOOKING_ACTIONS), booking_id: z.number().int().positive(), note: z.string().max(300).default('') }).strict(),
  z.object({ action: z.enum(RESOURCE_ACTIONS), resource_id: z.number().int().positive(), note: z.string().max(300).default('') }).strict(),
]);

export const maintenanceSchema = z.object({
  resource_id: z.number().int().positive(),
  starts_at: z.coerce.date(),
  ends_at: z.coerce.date(),
  reason: z.string().trim().max(300).default(''),
}).strict().refine((value) => value.ends_at > value.starts_at, 'The block must end after it starts');

async function logEvent(db, business, { resourceId, bookingId = null, action, from, to, note = '', actor }) {
  await db.query(
    `INSERT INTO operational_events (business_id, resource_id, booking_id, action, from_status, to_status, note, actor_user_id, actor_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [business.id, resourceId, bookingId, action, from, to, note, actor?.userId || null, actor?.email || actor?.label || '']);
}

async function setResourceStatus(db, business, resource, status, { action, bookingId, note, actor }) {
  await db.query(
    `UPDATE resources SET operational_status = $2, operational_note = $3, operational_updated_at = NOW(), operational_updated_by = $4
     WHERE id = $1`, [resource.id, status, note || '', actor?.userId || null]);
  await logEvent(db, business, { resourceId: resource.id, bookingId, action, from: resource.operational_status, to: status, note, actor });
}

async function occupant(db, business, resourceId, exceptBookingId = null) {
  return (await db.query(
    `SELECT id, reservation_name FROM bookings WHERE business_id = $1 AND resource_id = $2 AND status = 'checked_in'
       AND ($3::int IS NULL OR id <> $3) LIMIT 1`, [business.id, resourceId, exceptBookingId])).rows[0] || null;
}

export const internalOperations = {
  async apply(business, input, actor) {
    const data = operationSchema.parse(input);
    return withTransaction(async (db) => {
      if (RESOURCE_ACTIONS.includes(data.action)) {
        const resource = (await db.query(
          'SELECT * FROM resources WHERE id = $1 AND business_id = $2 AND archived_at IS NULL FOR UPDATE', [data.resource_id, business.id])).rows[0];
        if (!resource) throw notFound('Room or table not found.');
        const inside = await occupant(db, business, resource.id);
        // An occupied table is never "ready" just because its slot ended.
        if (inside) {
          throw new BookingError('not_ready', `${resource.code} is still occupied by ${inside.reservation_name || `reservation #${inside.id}`}. ` +
            'Finish that stay or sitting first.', { booking_id: inside.id });
        }
        const status = { mark_ready: 'ready', mark_needs_cleaning: 'needs_cleaning', mark_out_of_service: 'out_of_service' }[data.action];
        await setResourceStatus(db, business, resource, status, { action: data.action, note: data.note, actor });
        return { resource_id: Number(resource.id), operational_status: status, reservation: null, events: [] };
      }

      const row = (await db.query('SELECT * FROM bookings WHERE id = $1 AND business_id = $2 FOR UPDATE', [data.booking_id, business.id])).rows[0];
      if (!row) throw notFound('Reservation not found.');
      const arriving = Object.values(ARRIVE).includes(data.action);
      const finishing = Object.values(FINISH).includes(data.action);
      if ((arriving && data.action !== ARRIVE[row.service_type]) || (finishing && data.action !== FINISH[row.service_type])) {
        throw validationError(`"${data.action}" does not apply to a ${row.service_type} reservation.`);
      }

      if (data.action === 'no_show') {
        if (!['confirmed', 'modified', 'pending'].includes(row.status) || row.waitlisted) throw validationError('Only an expected reservation can be marked as a no-show.');
        if (row.starts_at && row.starts_at > new Date()) throw validationError('This reservation has not started yet.');
        await db.query(`UPDATE bookings SET status = 'no_show', calendar_sync_status = 'pending', updated_at = NOW() WHERE id = $1`, [row.id]);
        await logEvent(db, business, { resourceId: row.resource_id, bookingId: row.id, action: 'no_show', note: data.note, actor });
        return { reservation: await fetchReservation(db, business.id, row.id), events: ['no_show'], freed: { service_type: row.service_type } };
      }

      if (!row.resource_id) {
        throw validationError('No room or table is assigned to this reservation yet. Assign one first.', { reason: 'unassigned' });
      }
      const resource = (await db.query('SELECT * FROM resources WHERE id = $1 AND business_id = $2 FOR UPDATE', [row.resource_id, business.id])).rows[0];

      if (arriving) {
        if (!['confirmed', 'modified'].includes(row.status) || row.waitlisted) {
          throw validationError(row.status === 'pending' ? 'Confirm this reservation before the guest arrives.' : 'This reservation cannot be started.');
        }
        const today = todayKey(business.timezone);
        const startDay = zonedParts(row.starts_at, business.timezone).date;
        if (today < startDay) throw validationError(`This reservation is for ${startDay}; it cannot be started today.`, { reason: 'too_early' });
        if (row.ends_at <= new Date()) throw validationError('This reservation\'s time has already passed.', { reason: 'expired' });
        // Bookable in the future is not the same as ready right now.
        if (resource.operational_status !== 'ready') {
          const inside = await occupant(db, business, resource.id, row.id);
          throw new BookingError('not_ready', `${resource.code} is ${LABEL[resource.operational_status]}` +
            `${inside ? ` (occupied by ${inside.reservation_name || `reservation #${inside.id}`})` : ''}. It must be ready before the guest can use it.`,
          { operational_status: resource.operational_status, booking_id: inside?.id || null });
        }
        await db.query(`UPDATE bookings SET status = 'checked_in', service_started_at = NOW(), updated_at = NOW() WHERE id = $1`, [row.id]);
        await setResourceStatus(db, business, resource, 'in_use', { action: data.action, bookingId: row.id, note: data.note, actor });
        return { reservation: await fetchReservation(db, business.id, row.id), events: [] };
      }

      if (row.status !== 'checked_in') throw validationError('Only a stay, sitting or meeting that has started can be finished.');
      await db.query(`UPDATE bookings SET status = 'completed', service_ended_at = NOW(), calendar_sync_status = 'pending', updated_at = NOW() WHERE id = $1`, [row.id]);
      // Finishing moves the resource into turnaround; it is not assumed clean.
      await setResourceStatus(db, business, resource, 'needs_cleaning', { action: data.action, bookingId: row.id, note: data.note, actor });
      return { reservation: await fetchReservation(db, business.id, row.id), events: ['completed'], freed: { service_type: row.service_type } };
    });
  },

  async addMaintenance(business, input, actor) {
    const data = maintenanceSchema.parse(input);
    return withTransaction(async (db) => {
      // Same row lock the booking transaction takes, so a block and a booking
      // for the same resource cannot interleave.
      const resource = (await db.query(
        'SELECT * FROM resources WHERE id = $1 AND business_id = $2 AND archived_at IS NULL FOR UPDATE', [data.resource_id, business.id])).rows[0];
      if (!resource) throw notFound('Room or table not found.');
      const block = (await db.query(
        `INSERT INTO maintenance_blocks (business_id, resource_id, period, reason, created_by)
         VALUES ($1, $2, tstzrange($3, $4, '[)'), $5, $6) RETURNING id`,
        [business.id, resource.id, data.starts_at, data.ends_at, data.reason, actor?.userId || null])).rows[0];
      const affected = (await db.query(
        `SELECT id, reservation_name, starts_at, ends_at FROM bookings
         WHERE business_id = $1 AND resource_id = $2 AND status = ANY($3::text[]) AND waitlisted = FALSE
           AND hold_period && tstzrange($4, $5, '[)') ORDER BY starts_at`,
        [business.id, resource.id, HOLDING_STATUSES, data.starts_at, data.ends_at])).rows;
      await logEvent(db, business, { resourceId: resource.id, action: 'maintenance_added', note: data.reason, actor });
      // Existing reservations are not cancelled; they are surfaced as conflicts.
      return { id: Number(block.id), resource_id: Number(resource.id), conflicts: affected };
    });
  },

  async removeMaintenance(business, blockId, actor) {
    const removed = (await query(
      `UPDATE maintenance_blocks SET removed_at = NOW(), removed_by = $3
       WHERE id = $1 AND business_id = $2 AND removed_at IS NULL RETURNING resource_id`, [blockId, business.id, actor?.userId || null])).rows[0];
    if (!removed) throw notFound('Maintenance block not found.');
    await logEvent({ query }, business, { resourceId: removed.resource_id, action: 'maintenance_removed', actor });
    return { removed: true, freed: true };
  },
};

/** Room/table cards plus the day's schedule, with everything needing attention. */
export async function operationsBoard(business, { date, serviceType } = {}) {
  const day = isDateKey(date) ? date : todayKey(business.timezone);
  const { start, end } = localDayBounds(day, business.timezone);
  const now = new Date();
  const soon = new Date(now.getTime() + SOON_MINUTES * 60000);

  const resources = (await query(
    `SELECT r.id, r.service_type, r.code, r.name, r.is_active, r.managed_by, r.operational_status, r.operational_note,
            r.operational_updated_at, u.email AS operational_updated_by, t.name AS type_name
     FROM resources r JOIN resource_types t ON t.id = r.resource_type_id LEFT JOIN users u ON u.id = r.operational_updated_by
     WHERE r.business_id = $1 AND r.archived_at IS NULL AND ($2::text IS NULL OR r.service_type = $2)
     ORDER BY r.service_type, r.code`, [business.id, serviceType || null])).rows;

  const bookings = (await query(
    `${RESERVATION_SELECT}
     WHERE b.business_id = $1 AND ($2::text IS NULL OR b.service_type = $2)
       AND (b.status = 'checked_in'
         OR (b.status = ANY($3::text[]) AND b.starts_at < $5 AND b.ends_at > $4)
         OR (b.status IN ('completed', 'no_show', 'awaiting_confirmation') AND b.starts_at < $5 AND b.ends_at > $4)
         OR (b.waitlisted AND b.status = 'pending' AND b.starts_at < $5 AND b.ends_at > $4))
     ORDER BY b.starts_at NULLS LAST, b.id`, [business.id, serviceType || null, HOLDING_STATUSES, start, end])).rows.map(shapeReservation);

  const blocks = (await query(
    `SELECT m.id, m.resource_id, lower(m.period) AS starts_at, upper(m.period) AS ends_at, m.reason
     FROM maintenance_blocks m JOIN resources r ON r.id = m.resource_id
     WHERE m.business_id = $1 AND m.removed_at IS NULL AND upper(m.period) > $2 AND ($3::text IS NULL OR r.service_type = $3)
     ORDER BY lower(m.period)`, [business.id, now < start ? now : start, serviceType || null])).rows
    .map((row) => ({ ...row, id: Number(row.id), resource_id: Number(row.resource_id) }));

  const attention = [];
  const cards = resources.map((resource) => {
    const id = Number(resource.id);
    const mine = bookings.filter((booking) => booking.resource?.id === id);
    const current = mine.find((booking) => booking.status === 'checked_in') || null;
    const upcoming = mine.filter((booking) => HOLDING_STATUSES.includes(booking.status) && booking.status !== 'checked_in'
      && new Date(booking.ends_at) > now).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    const next = upcoming[0] || null;
    const resourceBlocks = blocks.filter((block) => block.resource_id === id);
    const flags = [];
    // Overdue: the guest is still there after the expected end. The resource
    // stays "in use" until staff finish it.
    if (current && new Date(current.ends_at) < now) {
      flags.push({ code: 'overdue', message: `${current.reservation_name || 'Guest'} was due to leave at ${current.end_time?.slice(0, 5)}.`, booking_id: current.id });
    }
    if (next && new Date(next.starts_at) <= soon && resource.operational_status !== 'ready') {
      flags.push({ code: 'not_ready_for_next', message: `Next reservation (${next.reservation_name || `#${next.id}`}) is due and ${resource.code} is ${LABEL[resource.operational_status]}.`, booking_id: next.id });
    }
    for (const block of resourceBlocks) {
      for (const booking of mine.filter((item) => HOLDING_STATUSES.includes(item.status)
        && new Date(item.starts_at) < new Date(block.ends_at) && new Date(item.ends_at) > new Date(block.starts_at))) {
        flags.push({ code: 'maintenance_conflict', message: `Reservation #${booking.id} overlaps maintenance${block.reason ? ` (${block.reason})` : ''}.`, booking_id: booking.id });
      }
    }
    if (!resource.is_active && upcoming.length) flags.push({ code: 'inactive_with_bookings', message: `${resource.code} is inactive but has upcoming reservations.` });
    for (const booking of mine.filter((item) => item.legacy_review)) {
      flags.push({ code: 'double_booked', message: `Reservation #${booking.id} overlaps another reservation (migrated data).`, booking_id: booking.id });
    }
    for (const flag of flags) attention.push({ ...flag, resource_id: id, resource_code: resource.code, service_type: resource.service_type });
    return { id, service_type: resource.service_type, code: resource.code, name: resource.name, type_name: resource.type_name,
      is_active: resource.is_active, managed_by: resource.managed_by,
      operational_status: resource.operational_status, operational_note: resource.operational_note,
      operational_updated_at: resource.operational_updated_at, operational_updated_by: resource.operational_updated_by,
      current, next, maintenance: resourceBlocks, flags };
  });

  for (const booking of bookings) {
    if (!booking.resource && HOLDING_STATUSES.includes(booking.status) && !booking.waitlisted && booking.source === 'internal') {
      attention.push({ code: 'unassigned', service_type: booking.service_type, booking_id: booking.id,
        message: `Reservation #${booking.id} (${booking.reservation_name || 'unnamed'}) has no room or table assigned.` });
    }
    if (booking.status === 'awaiting_confirmation' || booking.attention_reason) {
      attention.push({ code: 'provider_attention', service_type: booking.service_type, booking_id: booking.id,
        message: `Reservation #${booking.id}: ${booking.attention_reason || 'awaiting confirmation from the connected system'}.` });
    }
  }

  return { date: day, timezone: business.timezone, generated_at: now.toISOString(), cards, schedule: bookings, maintenance: blocks, attention };
}

export async function operationalHistory(businessId, resourceId, limit = 30) {
  return (await query(
    `SELECT id, action, from_status, to_status, note, actor_label, booking_id, created_at FROM operational_events
     WHERE business_id = $1 AND resource_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3`, [businessId, resourceId, Math.min(limit, 200)])).rows;
}
