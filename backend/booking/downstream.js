// Downstream effects of an authoritative booking change: Google Calendar
// (display only) and customer/staff notifications.
//
// Calendar never drives reservations: a Calendar outage cannot undo a booking
// and a deleted Calendar event cannot cancel one. Failed updates are retried
// by a durable job that only ever touches the Calendar event.
import { query } from '../services/db.js';
import { upsertEvent, cancelEvent, isCalendarSyncEnabled } from '../services/googleCalendar.js';
import { notifyBooking } from '../services/notifications.js';
import { getBusinessSetting } from '../services/appSettings.js';
import { enqueueJob, runJobNow, registerJobHandler } from './sync/jobs.js';

export async function calendarTarget(business) {
  const own = await getBusinessSetting(business.id, 'google_calendar_id');
  // Only the pre-platform business inherits the deployment-wide calendar.
  const calendarId = own || (business.is_legacy ? process.env.GOOGLE_CALENDAR_ID : '') || '';
  return { calendarId, enabled: Boolean(calendarId) && isCalendarSyncEnabled(calendarId) };
}

async function syncBookingToCalendar(business, bookingId) {
  const target = await calendarTarget(business);
  // Dates are passed to Calendar as plain property-local 'YYYY-MM-DD' strings.
  const row = (await query(
    `SELECT b.*, b.date::text AS date, b.end_date::text AS end_date FROM bookings b WHERE b.id = $1 AND b.business_id = $2`,
    [bookingId, business.id])).rows[0];
  if (!row) return { status: 'not_required' };
  if (!target.enabled) {
    await query(`UPDATE bookings SET calendar_sync_status = 'none' WHERE id = $1`, [row.id]);
    return { status: 'disabled' };
  }
  // A waitlist entry has no calendar entry; a legacy row that kept its waitlist
  // flag after being confirmed keeps the event it already has.
  const shown = ['confirmed', 'modified', 'checked_in', 'completed'].includes(row.status) && (!row.waitlisted || Boolean(row.google_event_id));
  const removed = ['cancelled', 'no_show'].includes(row.status);
  if (shown) {
    const eventId = await upsertEvent(row, target);
    if (!eventId) throw new Error('Google Calendar could not be updated.');
    // Only Calendar bookkeeping columns are written — never the status.
    await query(`UPDATE bookings SET google_event_id = $2, calendar_sync_status = 'synced' WHERE id = $1`, [row.id, eventId]);
    return { status: 'synced' };
  }
  if (removed && row.google_event_id) {
    if (!(await cancelEvent(row.google_event_id, target))) throw new Error('Google Calendar event could not be removed.');
    await query(`UPDATE bookings SET google_event_id = NULL, calendar_sync_status = 'synced' WHERE id = $1`, [row.id]);
    return { status: 'synced' };
  }
  await query(`UPDATE bookings SET calendar_sync_status = 'none' WHERE id = $1`, [row.id]);
  return { status: removed ? 'synced' : 'not_required' };
}

registerJobHandler('calendar_sync', async (job) => {
  const business = (await query('SELECT * FROM businesses WHERE id = $1', [job.business_id])).rows[0];
  if (!business) return {};
  try {
    return await syncBookingToCalendar(business, job.payload.booking_id);
  } catch (err) {
    await query(`UPDATE bookings SET calendar_sync_status = 'failed' WHERE id = $1 AND business_id = $2`, [job.payload.booking_id, job.business_id]);
    throw err;
  }
});

/**
 * Queue a Calendar update and try it once immediately so the caller can tell
 * the customer what happened. A failure leaves the job queued for retry.
 */
export async function syncCalendar(business, bookingId) {
  const target = await calendarTarget(business);
  if (!target.enabled) {
    await query(`UPDATE bookings SET calendar_sync_status = 'none' WHERE id = $1 AND business_id = $2`, [bookingId, business.id]);
    return { status: 'disabled' };
  }
  const jobId = await enqueueJob(null, { businessId: business.id, kind: 'calendar_sync', dedupeKey: `booking:${bookingId}`, payload: { booking_id: bookingId } });
  const result = await runJobNow(jobId);
  if (!result) return { status: 'pending' };
  // On failure the job stays queued and is retried with backoff.
  return result.status === 'succeeded' ? { status: result.outcome?.status || 'synced' } : { status: 'failed' };
}

/** Re-export every eligible reservation to Calendar (manual repair). Never changes a status. */
export async function repairCalendar(business, limit = 100) {
  const target = await calendarTarget(business);
  const summary = { enabled: target.enabled, checked: 0, synced: [], skipped: [], errors: [] };
  if (!target.enabled) return summary;
  const rows = (await query(
    `SELECT id, status, waitlisted FROM bookings WHERE business_id = $1 AND status NOT IN ('cancelled', 'no_show')
     ORDER BY updated_at DESC LIMIT $2`, [business.id, Math.min(Math.max(Number(limit) || 100, 1), 500)])).rows;
  summary.checked = rows.length;
  for (const row of rows) {
    if (row.waitlisted || !['confirmed', 'modified', 'checked_in', 'completed'].includes(row.status)) {
      summary.skipped.push({ id: row.id, reason: row.waitlisted ? 'waitlisted' : 'not_confirmed' });
      continue;
    }
    const result = await syncCalendar(business, row.id);
    if (result.status === 'synced') summary.synced.push({ id: row.id, status: 'synced' });
    else summary.errors.push({ id: row.id, error: 'Google Calendar could not be updated. It will be retried.' });
  }
  return summary;
}

const NOTIFY = { created: 'confirm', promoted: 'waitlist_open', cancelled: 'cancel' };

/**
 * Run after the booking transaction has committed. `events` comes from the
 * provider result and is empty on an idempotent replay, so a retry never
 * notifies the customer twice.
 */
export async function afterChange(business, result) {
  const reservation = result?.reservation;
  if (!reservation) return { calendar_sync: { status: 'not_required' } };
  let calendar = { status: 'not_required' };
  try {
    calendar = await syncCalendar(business, reservation.id);
  } catch (err) {
    console.error('[calendar]', err.message);
    calendar = { status: 'failed' };
  }
  for (const event of result.events || []) {
    if (!NOTIFY[event]) continue;
    try {
      await notifyBooking({ type: NOTIFY[event], toEmail: reservation.contact_email, toPhone: reservation.contact_phone,
        booking: reservation, isVip: false, businessId: business.id, allowEnvFallback: business.is_legacy });
    } catch (err) {
      console.error('[notify]', err.message);
    }
  }
  return { calendar_sync: calendar };
}
