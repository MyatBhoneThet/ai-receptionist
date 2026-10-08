// Google Calendar is a downstream display. It can fail, be emptied or be out
// of date without ever changing an authoritative reservation.
import request from 'supertest';
import { resetDb, closeDb, makeBusiness, idem, bookingRow } from '../helpers/db.js';
import { loadApp } from '../helpers/app.js';
import { query } from '../../services/db.js';
import { setBusinessSetting } from '../../services/appSettings.js';

const ctx = await loadApp();
const { app, tokenFor, mockUpsertEvent, mockCancelEvent, mockCalendarEnabled, mockGetEventStatus, mockNotify, calendarTargets } = ctx;
const booking = await import('../../booking/service.js');
const jobs = await import('../../booking/sync/jobs.js');

let biz;
const create = (extra = {}) => booking.createReservation(biz.business, { service_type: 'restaurant', date: '2027-05-05', start_time: '19:00', people: 2,
  idempotency_key: idem(), customer: { name: 'Avery', phone: '0812345678' }, channel: 'phone', ...extra }, biz.actor);
const calendarJobs = async () => (await query(`SELECT status, attempts FROM sync_jobs WHERE kind = 'calendar_sync' ORDER BY id`)).rows;

beforeEach(async () => {
  await resetDb();
  ctx.resetMocks();
  mockCalendarEnabled.mockReturnValue(true);
  biz = await makeBusiness({ slug: 'cal', restaurant: { types: [{ name: 'Table', defaults: { seating_capacity: 4 }, codes: ['T1', 'T2'] }] } });
  await setBusinessSetting(biz.business.id, 'google_calendar_id', 'cal-business@example.test');
});
afterAll(closeDb);

it('writes confirmed reservations to the business\'s own calendar', async () => {
  mockUpsertEvent.mockResolvedValue('event-1');
  const result = await create();
  expect(result.calendar_sync).toEqual({ status: 'synced' });
  expect(await bookingRow(result.reservation.id)).toMatchObject({ google_event_id: 'event-1', calendar_sync_status: 'synced', status: 'confirmed' });
  expect(calendarTargets).toEqual([expect.objectContaining({ calendarId: 'cal-business@example.test' })]);
  expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({ id: result.reservation.id, date: '2027-05-05' }));
});

it('does not undo a reservation when Calendar is down, and retries without duplicating bookings or notifications', async () => {
  mockUpsertEvent.mockRejectedValue(new Error('Calendar API 503'));
  const result = await create();
  expect(result.calendar_sync).toEqual({ status: 'failed' });
  expect(result.reservation.status).toBe('confirmed');
  expect(await bookingRow(result.reservation.id)).toMatchObject({ status: 'confirmed', calendar_sync_status: 'failed', google_event_id: null });
  expect(await calendarJobs()).toEqual([{ status: 'queued', attempts: 1 }]);
  expect(mockNotify).toHaveBeenCalledTimes(1);

  // Still failing: the job is retried later, the reservation stays confirmed.
  await jobs.runDueJobs({ ignoreSchedule: true });
  expect(await calendarJobs()).toEqual([{ status: 'queued', attempts: 2 }]);
  expect((await bookingRow(result.reservation.id)).status).toBe('confirmed');

  mockUpsertEvent.mockReset().mockResolvedValue('event-after-outage');
  await jobs.runDueJobs({ ignoreSchedule: true });
  expect(await calendarJobs()).toEqual([{ status: 'succeeded', attempts: 3 }]);
  expect(await bookingRow(result.reservation.id)).toMatchObject({ status: 'confirmed', google_event_id: 'event-after-outage', calendar_sync_status: 'synced' });
  // Three Calendar attempts, one reservation, one customer notification.
  expect((await query('SELECT COUNT(*)::int AS n FROM bookings')).rows[0].n).toBe(1);
  expect(mockNotify).toHaveBeenCalledTimes(1);
});

it('does not cancel a reservation whose Calendar event was deleted; a repair simply recreates the event', async () => {
  mockUpsertEvent.mockResolvedValue('event-1');
  const { reservation } = await create();
  // Someone deletes the event in Google Calendar.
  mockGetEventStatus.mockResolvedValue({ available: false, reason: 'missing' });
  mockUpsertEvent.mockReset().mockResolvedValue('event-recreated');

  const auth = { Authorization: `Bearer ${tokenFor(biz.owner)}` };
  const repair = await request(app).post(`/api/b/${biz.business.id}/calendar/repair`).set(auth).send({});
  expect(repair.status).toBe(200);
  expect(repair.body).toMatchObject({ enabled: true, checked: 1, synced: [{ id: reservation.id, status: 'synced' }], errors: [] });
  expect(await bookingRow(reservation.id)).toMatchObject({ status: 'confirmed', google_event_id: 'event-recreated' });
  // There is no longer any endpoint that imports Calendar deletions as cancellations.
  const legacy = await request(app).post('/api/bookings/sync-calendar').set(auth).send({ mode: 'deletions' });
  expect(legacy.status).toBe(404);
  expect(mockGetEventStatus).not.toHaveBeenCalled();
  expect((await bookingRow(reservation.id)).status).toBe('confirmed');
});

it('removes the event when a reservation is cancelled and keeps the cancellation if Calendar fails', async () => {
  mockUpsertEvent.mockResolvedValue('event-1');
  const { reservation } = await create();
  mockCancelEvent.mockResolvedValue(false);
  const cancelled = await booking.cancelReservation(biz.business, reservation.id, {}, biz.actor);
  expect(cancelled.calendar_sync).toEqual({ status: 'failed' });
  expect(await bookingRow(reservation.id)).toMatchObject({ status: 'cancelled', google_event_id: 'event-1' });
  mockCancelEvent.mockResolvedValue(true);
  await jobs.runDueJobs({ ignoreSchedule: true });
  expect(await bookingRow(reservation.id)).toMatchObject({ status: 'cancelled', google_event_id: null, calendar_sync_status: 'synced' });
});

it('never sends one business\'s reservations to another business\'s calendar', async () => {
  const other = await makeBusiness({ slug: 'nocal', restaurant: { types: [{ name: 'Table', defaults: { seating_capacity: 4 }, codes: ['T1'] }] } });
  const result = await booking.createReservation(other.business, { service_type: 'restaurant', date: '2027-05-05', start_time: '19:00', people: 2,
    idempotency_key: idem(), customer: { name: 'Other' }, channel: 'phone' }, other.actor);
  expect(result.calendar_sync).toEqual({ status: 'disabled' });
  expect(mockUpsertEvent).not.toHaveBeenCalled();
});
