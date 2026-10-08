// Staff operations: walk-ins, arrivals, turnaround, maintenance, overdue
// occupancy and waitlist promotion — all on real PostgreSQL.
import { resetDb, closeDb, makeBusiness, idem, bookingRow } from '../helpers/db.js';
import { loadApp } from '../helpers/app.js';
import { query } from '../../services/db.js';
import { zonedParts, formatMinutes } from '../../platform/time.js';

const ctx = await loadApp();
const booking = await import('../../booking/service.js');

async function expectError(promise, code) {
  const err = await promise.then(() => null, (caught) => caught);
  expect(err?.code).toBe(code);
  return err;
}

let biz;
const TZ = 'Asia/Bangkok';
const now = () => zonedParts(new Date(), TZ);
const create = (request, extra = {}) => booking.createReservation(biz.business,
  { idempotency_key: idem(), customer: { name: 'Guest', phone: '0812345678' }, channel: 'staff', ...request, ...extra }, biz.actor);
const act = (input) => booking.applyOperation(biz.business, input, biz.actor);
const card = async (code) => (await booking.operationsBoard(biz.business)).cards.find((item) => item.code === code);

beforeEach(async () => {
  await resetDb();
  ctx.resetMocks();
  biz = await makeBusiness({ slug: 'ops', restaurant: {
    settings: { default_duration_minutes: 60, turnover_buffer_minutes: 0 },
    types: [{ name: 'Table', defaults: { seating_capacity: 4 }, codes: ['T1', 'T2'] },
      { name: 'Large table', defaults: { seating_capacity: 10 }, codes: ['L1'] }],
  } });
});
afterAll(closeDb);

const walkIn = (resourceCode, extra = {}) => {
  const local = now();
  return create({ service_type: 'restaurant', date: local.date, start_time: formatMinutes(local.minutes), people: 2,
    resource_id: biz.resources[resourceCode], immediate: true }, { channel: 'walk_in', ...extra });
};

describe('walk-ins and readiness', () => {
  it('seats a walk-in immediately and marks the table in use, recording who did it', async () => {
    const { reservation } = await walkIn('T1');
    expect(reservation).toMatchObject({ status: 'checked_in', channel: 'walk_in' });
    expect(reservation.resource).toMatchObject({ code: 'T1', operational_status: 'in_use' });
    const event = (await query('SELECT * FROM operational_events WHERE booking_id = $1', [reservation.id])).rows[0];
    expect(event).toMatchObject({ action: 'walk_in', from_status: 'ready', to_status: 'in_use', actor_user_id: biz.owner.id, actor_label: biz.owner.email });
  });

  it('refuses a walk-in on a table that is occupied or waiting to be cleaned', async () => {
    const first = await walkIn('T1');
    const occupied = await expectError(walkIn('T1'), 'conflict');
    expect(occupied.details.reason).toBe('full');

    await act({ action: 'finish', booking_id: first.reservation.id });
    expect((await card('T1')).operational_status).toBe('needs_cleaning');
    // The sitting is over, so the interval is free — but the table is not ready.
    const dirty = await expectError(walkIn('T1'), 'conflict');
    expect(dirty.details.reason).toBe('not_ready');

    // Cleaning does not block a future reservation on the same table.
    const future = await booking.checkAvailability(biz.business, { service_type: 'restaurant', date: '2027-08-01', start_time: '19:00',
      people: 2, resource_id: biz.resources.T1 });
    expect(future.selected).toMatchObject({ available: true, ready_now: false });

    await act({ action: 'mark_ready', resource_id: biz.resources.T1 });
    expect((await walkIn('T1')).reservation.status).toBe('checked_in');
  });

  it('moves a finished sitting to "needs cleaning" rather than assuming the table is clean', async () => {
    const { reservation } = await walkIn('T1');
    const done = await act({ action: 'finish', booking_id: reservation.id });
    expect(done.reservation).toMatchObject({ status: 'completed' });
    expect(done.reservation.service_ended_at).not.toBeNull();
    expect(done.reservation.resource.operational_status).toBe('needs_cleaning');
    const events = (await query('SELECT action, to_status FROM operational_events WHERE resource_id = $1 ORDER BY id', [biz.resources.T1])).rows;
    expect(events).toEqual([{ action: 'walk_in', to_status: 'in_use' }, { action: 'finish', to_status: 'needs_cleaning' }]);
  });

  it('keeps reservation status and operational status independent', async () => {
    const { reservation } = await create({ service_type: 'restaurant', date: '2027-08-01', start_time: '19:00', people: 2, resource_id: biz.resources.T1 });
    await act({ action: 'mark_out_of_service', resource_id: biz.resources.T1, note: 'Wobbly leg' });
    // Taking the table out of service did not cancel or alter the reservation.
    expect((await bookingRow(reservation.id)).status).toBe('confirmed');
    expect(await card('T1')).toMatchObject({ operational_status: 'out_of_service', operational_note: 'Wobbly leg', operational_updated_by: biz.owner.email });
  });

  it('rejects an action that belongs to a different service', async () => {
    const { reservation } = await walkIn('T1');
    await expectError(act({ action: 'check_out', booking_id: reservation.id }), 'validation');
  });
});

describe('overdue occupancy', () => {
  it('flags an overdue sitting and never marks an occupied table ready just because time ran out', async () => {
    const { reservation } = await walkIn('T1');
    // Their slot ended an hour ago but they are still sitting there.
    await query(
      `UPDATE bookings SET starts_at = NOW() - INTERVAL '2 hours', ends_at = NOW() - INTERVAL '1 hour',
              hold_period = tstzrange(NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour', '[)') WHERE id = $1`, [reservation.id]);

    const board = await booking.operationsBoard(biz.business);
    const t1 = board.cards.find((item) => item.code === 'T1');
    expect(t1.operational_status).toBe('in_use');
    expect(t1.current.id).toBe(reservation.id);
    expect(t1.flags.map((flag) => flag.code)).toContain('overdue');
    expect(board.attention.some((item) => item.code === 'overdue' && item.resource_code === 'T1')).toBe(true);

    const refused = await expectError(act({ action: 'mark_ready', resource_id: biz.resources.T1 }), 'not_ready');
    expect(refused.details.booking_id).toBe(reservation.id);
    expect((await card('T1')).operational_status).toBe('in_use');
    // A new walk-in cannot be seated there either, although the booked slot is over.
    expect((await expectError(walkIn('T1'), 'conflict')).details.reason).toBe('not_ready');
  });

  it('warns when the next reservation is due and the table is not ready', async () => {
    const local = now();
    const soon = formatMinutes(Math.min(local.minutes + 10, 1439));
    await act({ action: 'mark_needs_cleaning', resource_id: biz.resources.T2 });
    const { reservation } = await create({ service_type: 'restaurant', date: local.date, start_time: soon, people: 2, resource_id: biz.resources.T2 });
    const t2 = await card('T2');
    expect(t2.next.id).toBe(reservation.id);
    expect(t2.flags.map((flag) => flag.code)).toContain('not_ready_for_next');
    const notReady = await expectError(act({ action: 'seat', booking_id: reservation.id }), 'not_ready');
    expect(notReady.details.operational_status).toBe('needs_cleaning');
  });
});

describe('maintenance blocks', () => {
  const slot = { service_type: 'restaurant', date: '2027-09-10', people: 2 };
  const at = (time) => new Date(`2027-09-10T${time}:00+07:00`);

  it('blocks only the timed interval and frees it again when removed', async () => {
    const block = await booking.addMaintenance(biz.business, { resource_id: biz.resources.T1, starts_at: at('12:00'), ends_at: at('15:00'), reason: 'Re-upholstering' }, biz.actor);
    const during = await booking.checkAvailability(biz.business, { ...slot, start_time: '13:00', resource_id: biz.resources.T1 });
    expect(during.options[0]).toMatchObject({ available: false, reason: 'maintenance', message: 'Re-upholstering' });
    const after = await booking.checkAvailability(biz.business, { ...slot, start_time: '15:00', resource_id: biz.resources.T1 });
    expect(after.selected.available).toBe(true);
    const otherDay = await booking.checkAvailability(biz.business, { ...slot, date: '2027-09-11', start_time: '13:00', resource_id: biz.resources.T1 });
    expect(otherDay.selected.available).toBe(true);
    await expectError(create({ ...slot, start_time: '14:30', resource_id: biz.resources.T1 }), 'conflict');

    await booking.removeMaintenance(biz.business, block.id, biz.actor);
    expect((await create({ ...slot, start_time: '14:30', resource_id: biz.resources.T1 })).reservation.status).toBe('confirmed');
  });

  it('surfaces existing reservations as conflicts instead of cancelling them', async () => {
    const { reservation } = await create({ ...slot, start_time: '13:00', resource_id: biz.resources.T1 });
    const block = await booking.addMaintenance(biz.business, { resource_id: biz.resources.T1, starts_at: at('12:00'), ends_at: at('15:00'), reason: 'Leak' }, biz.actor);
    expect(block.conflicts.map((item) => item.id)).toEqual([reservation.id]);
    expect((await bookingRow(reservation.id)).status).toBe('confirmed');
    const board = await booking.operationsBoard(biz.business, { date: '2027-09-10' });
    expect(board.attention.find((item) => item.code === 'maintenance_conflict')).toMatchObject({ booking_id: reservation.id, resource_code: 'T1' });
  });
});

describe('waitlist', () => {
  const evening = (people, extra = {}) => ({ service_type: 'restaurant', date: '2027-10-01', start_time: '19:00', people, ...extra });

  it('never consumes inventory or appears confirmed', async () => {
    await create(evening(8));
    const waiting = await create(evening(8), { waitlist_if_unavailable: true });
    expect(waiting.reservation).toMatchObject({ status: 'pending', waitlisted: true, display_status: 'waitlisted', resource: null });
    expect((await bookingRow(waiting.reservation.id)).hold_period).toBeNull();
    expect(ctx.mockNotify.mock.calls.map(([call]) => call.type)).toEqual(['confirm']);
    // The waitlist entry does not block anyone: the small tables are still bookable.
    expect((await create(evening(2))).reservation.status).toBe('confirmed');
    // A rule violation cannot be waitlisted at all.
    await expectError(create(evening(40), { waitlist_if_unavailable: true }), 'conflict');
  });

  it('promotes only a request whose full party size, time and duration fit the freed table', async () => {
    const held = await create(evening(2, { resource_id: biz.resources.T1 }));
    await create(evening(2, { resource_id: biz.resources.T2 }));
    await create(evening(8, { resource_id: biz.resources.L1 }));

    const bigParty = await create(evening(8), { waitlist_if_unavailable: true, customer: { name: 'Big Party', phone: '0810000001' } });
    const otherTime = await create(evening(2, { start_time: '19:30' }), { waitlist_if_unavailable: true, customer: { name: 'Half Past', phone: '0810000002' } });
    const couple = await create(evening(2), { waitlist_if_unavailable: true, customer: { name: 'Couple', phone: '0810000003' } });
    expect([bigParty, otherTime, couple].every((entry) => entry.reservation.waitlisted)).toBe(true);
    ctx.mockNotify.mockClear();

    // A four-seat table at 19:00–20:00 becomes free.
    const cancelled = await booking.cancelReservation(biz.business, held.reservation.id, {}, biz.actor);
    const promotedIds = cancelled.promoted.map((reservation) => reservation.id);

    // The party of eight was first in line but does not fit a table for four.
    expect((await bookingRow(bigParty.reservation.id))).toMatchObject({ waitlisted: true, status: 'pending', resource_id: null });
    // 19:30–20:30 fits the freed T1 (19:00–20:00 was the only thing on it), so it is promoted first…
    expect(promotedIds).toEqual([otherTime.reservation.id]);
    const promoted = await bookingRow(otherTime.reservation.id);
    expect(promoted).toMatchObject({ waitlisted: false, status: 'confirmed' });
    expect(Number(promoted.resource_id)).toBe(biz.resources.T1);
    expect(promoted.hold_period).not.toBeNull();
    // …which leaves no room for the 19:00 couple: promotion re-checked real availability.
    expect((await bookingRow(couple.reservation.id))).toMatchObject({ waitlisted: true, status: 'pending' });
    expect(ctx.mockNotify.mock.calls.map(([call]) => call.type)).toEqual(['cancel', 'waitlist_open']);
  });

  it('cannot be double-promoted into the same table', async () => {
    const held = await create(evening(8, { resource_id: biz.resources.L1 }));
    const first = await create(evening(8), { waitlist_if_unavailable: true, customer: { name: 'First', phone: '0810000001' } });
    const second = await create(evening(8), { waitlist_if_unavailable: true, customer: { name: 'Second', phone: '0810000002' } });
    await booking.cancelReservation(biz.business, held.reservation.id, {}, biz.actor);
    await Promise.all([booking.promoteWaitlist(biz.business, 'restaurant'), booking.promoteWaitlist(biz.business, 'restaurant')]);
    expect((await bookingRow(first.reservation.id)).waitlisted).toBe(false);
    expect((await bookingRow(second.reservation.id)).waitlisted).toBe(true);
    const onTable = await query(`SELECT COUNT(*)::int AS n FROM bookings WHERE resource_id = $1 AND status = 'confirmed'`, [biz.resources.L1]);
    expect(onTable.rows[0].n).toBe(1);
  });
});

describe('hotel and meeting operations', () => {
  let hotel;
  beforeEach(async () => {
    hotel = await makeBusiness({ slug: 'inn', hotel: { types: [{ name: 'Standard', defaults: { max_guests: 2, base_rate: '1000' }, codes: ['101'] }] },
      meeting: { settings: { min_duration_minutes: 30, increment_minutes: 15 }, types: [{ name: 'Room', defaults: { layouts: [{ name: 'Standard', capacity: 8 }] }, codes: ['M1'] }] } });
  });

  it('checks a guest in and out, leaving the room to be cleaned', async () => {
    const today = now().date;
    const tomorrow = zonedParts(new Date(Date.now() + 2 * 86400000), TZ).date;
    const { reservation } = await booking.createReservation(hotel.business, { service_type: 'hotel', date: today, end_date: tomorrow, people: 2,
      idempotency_key: idem(), customer: { name: 'Stay' }, channel: 'phone' }, hotel.actor);
    const arrived = await booking.applyOperation(hotel.business, { action: 'check_in', booking_id: reservation.id }, hotel.actor);
    expect(arrived.reservation).toMatchObject({ status: 'checked_in' });
    expect(arrived.reservation.resource.operational_status).toBe('in_use');
    await expectError(booking.cancelReservation(hotel.business, reservation.id, {}, hotel.actor), 'validation');
    const left = await booking.applyOperation(hotel.business, { action: 'check_out', booking_id: reservation.id }, hotel.actor);
    expect(left.reservation.status).toBe('completed');
    expect(left.reservation.resource.operational_status).toBe('needs_cleaning');
    // The next guest can be booked from today, but cannot check in until the room is ready.
    const next = await booking.createReservation(hotel.business, { service_type: 'hotel', date: today, end_date: tomorrow, people: 1,
      idempotency_key: idem(), customer: { name: 'Next' }, channel: 'phone' }, hotel.actor);
    await expectError(booking.applyOperation(hotel.business, { action: 'check_in', booking_id: next.reservation.id }, hotel.actor), 'not_ready');
    await booking.applyOperation(hotel.business, { action: 'mark_ready', resource_id: hotel.resources['101'] }, hotel.actor);
    expect((await booking.applyOperation(hotel.business, { action: 'check_in', booking_id: next.reservation.id }, hotel.actor)).reservation.status).toBe('checked_in');
  });

  it('does not start a reservation that is for a future day', async () => {
    const { reservation } = await booking.createReservation(hotel.business, { service_type: 'hotel', date: '2027-12-01', end_date: '2027-12-03', people: 2,
      idempotency_key: idem(), customer: { name: 'Later' }, channel: 'phone' }, hotel.actor);
    const err = await expectError(booking.applyOperation(hotel.business, { action: 'check_in', booking_id: reservation.id }, hotel.actor), 'validation');
    expect(err.details.reason).toBe('too_early');
  });
});
