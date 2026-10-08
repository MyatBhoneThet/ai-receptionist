// Internal booking engine against real PostgreSQL: availability rules,
// transactional double-booking protection, idempotency and modification safety.
import { resetDb, closeDb, makeBusiness, idem, bookingRow } from '../helpers/db.js';
import { query } from '../../services/db.js';
import * as booking from '../../booking/service.js';

const guest = (name = 'Avery Stone', phone = '0812345678') => ({ name, phone });

async function expectError(promise, code) {
  const err = await promise.then(() => null, (caught) => caught);
  expect(err?.code).toBe(code);
  return err;
}

async function book(business, request, extra = {}) {
  return booking.createReservation(business, { idempotency_key: idem(), customer: guest(), channel: 'staff', ...request, ...extra }, { label: 'test' });
}

afterAll(closeDb);

describe('hotel stays', () => {
  let biz;
  beforeEach(async () => {
    await resetDb();
    biz = await makeBusiness({ slug: 'grand-hotel', hotel: {
      settings: { check_in_time: '14:00', check_out_time: '11:00' },
      types: [{ name: 'Standard', defaults: { max_guests: 2, base_rate: '1500.00', min_stay_nights: 1 }, codes: ['101'] }],
    } });
  });

  const stay = (date, end_date, people = 2) => ({ service_type: 'hotel', date, end_date, people });

  it('stores check-in and check-out as property-local dates and prices the stay', async () => {
    const { reservation } = await book(biz.business, stay('2027-03-10', '2027-03-13'));
    expect(reservation).toMatchObject({ status: 'confirmed', date: '2027-03-10', end_date: '2027-03-13', total_amount: '4500', currency: 'THB' });
    expect(reservation.resource.code).toBe('101');
    // 14:00 Bangkok on the 10th is 07:00 UTC.
    expect(new Date(reservation.starts_at).toISOString()).toBe('2027-03-10T07:00:00.000Z');
    expect(new Date(reservation.ends_at).toISOString()).toBe('2027-03-13T04:00:00.000Z');
    expect(reservation.quote.policies).toMatchObject({ check_in_time: '14:00', check_out_time: '11:00' });
  });

  it('rejects an overlapping stay but allows a new stay to begin on the checkout date', async () => {
    await book(biz.business, stay('2027-03-10', '2027-03-13'));
    const overlap = await expectError(book(biz.business, stay('2027-03-12', '2027-03-14')), 'conflict');
    expect(overlap.details).toMatchObject({ reason: 'full', waitlist_possible: true });
    const adjacent = await book(biz.business, stay('2027-03-13', '2027-03-15'));
    expect(adjacent.reservation.status).toBe('confirmed');
    const before = await book(biz.business, stay('2027-03-08', '2027-03-10'));
    expect(before.reservation.status).toBe('confirmed');
  });

  it('enforces capacity and minimum stay in backend code', async () => {
    const tooMany = await expectError(book(biz.business, stay('2027-04-01', '2027-04-03', 3)), 'conflict');
    expect(tooMany.details.reason).toBe('capacity');
    await booking.checkAvailability(biz.business, stay('2027-04-01', '2027-04-02'));
    const { updateType } = await import('../../platform/inventory.js');
    await updateType(biz.business, biz.types.Standard.id, { defaults: { max_guests: 2, base_rate: '1500.00', min_stay_nights: 3 } }, biz.actor);
    const short = await booking.checkAvailability(biz.business, stay('2027-04-01', '2027-04-02'));
    expect(short.selected).toBeNull();
    expect(short.reason).toMatchObject({ code: 'min_stay' });
    expect(short.waitlist_possible).toBe(false);
    await expectError(book(biz.business, stay('2027-04-03', '2027-04-03')), 'validation');
  });

  it('distinguishes future bookability from readiness for immediate check-in', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
    const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(Date.now() + 86400000 * 2));
    await booking.applyOperation(biz.business, { action: 'mark_needs_cleaning', resource_id: biz.resources['101'] }, biz.actor);

    // A room that needs cleaning today is still bookable for the future…
    const future = await booking.checkAvailability(biz.business, stay('2027-06-01', '2027-06-02'));
    expect(future.selected).toMatchObject({ available: true, ready_now: false, operational_status: 'needs_cleaning' });
    // …but a guest cannot be checked into it now.
    const { reservation } = await book(biz.business, stay(today, tomorrow));
    const notReady = await expectError(booking.applyOperation(biz.business, { action: 'check_in', booking_id: reservation.id }, biz.actor), 'not_ready');
    expect(notReady.details.operational_status).toBe('needs_cleaning');
    expect((await bookingRow(reservation.id)).status).toBe('confirmed');
  });
});

describe('restaurant tables', () => {
  let biz;
  beforeEach(async () => {
    await resetDb();
    biz = await makeBusiness({ slug: 'bistro', restaurant: {
      settings: { default_duration_minutes: 90, turnover_buffer_minutes: 15,
        operating_hours: { fri: [{ open: '18:00', close: '02:00' }], sat: [{ open: '11:00', close: '23:00' }] } },
      types: [
        { name: 'Standard indoor table', defaults: { seating_capacity: 4, seating_area: 'indoor' }, codes: ['T01'] },
        { name: 'Private table', defaults: { seating_capacity: 8, seating_area: 'private', min_spend: '3000', deposit: { type: 'fixed', amount: '500' }, booking_fee: '100' }, codes: ['P01'] },
      ],
    } });
  });

  // 2027-01-02 is a Saturday, 2027-01-01 a Friday.
  const table = (start_time, people = 2, extra = {}) => ({ service_type: 'restaurant', date: '2027-01-02', start_time, people, ...extra });

  it('applies the default duration and blocks the turnover buffer after a sitting', async () => {
    const first = await book(biz.business, table('12:00'));
    expect(first.reservation).toMatchObject({ start_time: '12:00:00', end_time: '13:30:00' });
    expect(first.reservation.resource.code).toBe('T01');

    // 13:30 falls inside the 15-minute turnover buffer of T01, so only the private table is free.
    const insideBuffer = await booking.checkAvailability(biz.business, table('13:30'));
    expect(insideBuffer.options.find((option) => option.resource.code === 'T01')).toMatchObject({ available: false, reason: 'booked' });
    expect(insideBuffer.selected.resource.code).toBe('P01');
    const afterBuffer = await booking.checkAvailability(biz.business, table('13:45'));
    expect(afterBuffer.selected.resource.code).toBe('T01');
  });

  it('keeps minimum spend, deposit and booking fee as three separate amounts', async () => {
    const { reservation } = await book(biz.business, table('19:00', 6));
    expect(reservation.resource.code).toBe('P01');
    expect(reservation.quote).toMatchObject({ minimum_spend: '3000.00', booking_fee: '100.00', total: '100.00', currency: 'THB' });
    expect(reservation.quote.deposit).toMatchObject({ required: true, amount: '500.00' });
    expect(reservation).toMatchObject({ min_spend_amount: '3000', booking_fee_amount: '100', total_amount: '100' });
    expect(reservation.deposit).toMatchObject({ amount: '500', status: 'due' });
    // Recording a deposit is a staff action and never alters the other amounts.
    const paid = await booking.recordDeposit(biz.business, reservation.id, 'recorded_paid', biz.actor);
    expect(paid.reservation.deposit.status).toBe('recorded_paid');
    expect(paid.reservation).toMatchObject({ min_spend_amount: '3000', total_amount: '100' });
  });

  it('keeps the accepted price on the reservation when settings change later', async () => {
    const { reservation } = await book(biz.business, table('19:00', 6));
    const { updateType } = await import('../../platform/inventory.js');
    await updateType(biz.business, biz.types['Private table'].id, { defaults: { seating_capacity: 8, seating_area: 'private', min_spend: '9000' } }, biz.actor);
    expect((await booking.getReservation(biz.business, reservation.id)).min_spend_amount).toBe('3000');
    const fresh = await booking.checkAvailability(biz.business, table('15:00', 6));
    expect(fresh.selected.quote.minimum_spend).toBe('9000.00');
  });

  it('honours operating hours, including a period that runs past midnight', async () => {
    const closed = await booking.checkAvailability(biz.business, table('09:00'));
    expect(closed.reason.code).toBe('outside_hours');
    const lateEnd = await booking.checkAvailability(biz.business, table('22:00'));
    expect(lateEnd.reason.code).toBe('outside_hours');          // would end 23:30, after closing

    // Friday opens 18:00 and closes 02:00 on Saturday.
    const friday = { service_type: 'restaurant', date: '2027-01-01', people: 2 };
    const overnight = await book(biz.business, { ...friday, start_time: '23:30' });
    expect(overnight.reservation).toMatchObject({ date: '2027-01-01', start_time: '23:30:00', end_time: '01:00:00' });
    expect(new Date(overnight.reservation.ends_at) - new Date(overnight.reservation.starts_at)).toBe(90 * 60000);
    // 00:30 on Saturday still belongs to Friday's overnight period.
    const afterMidnight = await booking.checkAvailability(biz.business, { ...table('00:30'), date: '2027-01-02' });
    expect(afterMidnight.selected).not.toBeNull();
    const tooLate = await booking.checkAvailability(biz.business, { ...friday, start_time: '01:00' });
    expect(tooLate.reason.code).toBe('outside_hours');          // Friday 01:00 is before Friday's opening
  });

  it('treats blank optional fields from forms and chat as not provided', async () => {
    const result = await booking.checkAvailability(biz.business, { service_type: 'restaurant', date: '02-01-2027', end_date: '',
      start_time: '12:00:00', end_time: '', people: '2', preference: '', layout: '', resource_id: '' });
    expect(result.selected.resource.code).toBe('T01');
    expect(result.plan).toMatchObject({ date: '2027-01-02', start_time: '12:00', end_time: '13:30' });
  });

  it('rejects a party larger than any table', async () => {
    const err = await expectError(book(biz.business, table('12:00', 9)), 'conflict');
    expect(err.details).toMatchObject({ reason: 'capacity', waitlist_possible: false });
  });
});

describe('meeting rooms', () => {
  let biz;
  beforeEach(async () => {
    await resetDb();
    biz = await makeBusiness({ slug: 'offices', meeting: {
      settings: { min_duration_minutes: 60, increment_minutes: 30, setup_buffer_minutes: 30, cleanup_buffer_minutes: 15 },
      types: [{ name: 'Boardroom', defaults: { rate_unit: 'hourly', base_rate: '800',
        layouts: [{ name: 'Boardroom', capacity: 12 }, { name: 'Theatre', capacity: 30 }] }, codes: ['M1'] }],
    } });
  });

  const meeting = (start_time, end_time, extra = {}) => ({ service_type: 'meeting', date: '2027-02-03', start_time, end_time, people: 8, ...extra });

  it('requires setup and cleanup buffers between meetings', async () => {
    const first = await book(biz.business, meeting('10:00', '12:00'));
    expect(first.reservation.total_amount).toBe('1600');
    // Needs 15 min cleanup + 30 min setup: the next meeting cannot start before 12:45.
    await expectError(book(biz.business, meeting('12:30', '13:30')), 'conflict');
    const ok = await book(biz.business, meeting('13:00', '14:00'));
    expect(ok.reservation.status).toBe('confirmed');
    // And nothing may end later than 09:30 before the 10:00 meeting's setup.
    await expectError(book(biz.business, meeting('08:30', '09:45')), 'conflict');
  });

  it('enforces minimum duration, increments and capacity by layout', async () => {
    expect((await booking.checkAvailability(biz.business, meeting('15:00', '15:30'))).reason.code).toBe('min_duration');
    expect((await booking.checkAvailability(biz.business, meeting('15:10', '16:10'))).reason.code).toBe('increment');
    expect((await booking.checkAvailability(biz.business, meeting('15:00', '16:00', { people: 20, layout: 'Boardroom' }))).reason.code).toBe('capacity');
    const theatre = await booking.checkAvailability(biz.business, meeting('15:00', '16:00', { people: 20, layout: 'Theatre' }));
    expect(theatre.selected).toMatchObject({ capacity: 30, available: true });
    expect(theatre.selected.quote.policies).toMatchObject({ layout: 'Theatre', setup_buffer_minutes: 30 });
  });
});

describe('concurrency, idempotency and modification safety', () => {
  let biz;
  beforeEach(async () => {
    await resetDb();
    biz = await makeBusiness({ slug: 'solo', restaurant: {
      settings: { default_duration_minutes: 60, turnover_buffer_minutes: 0 },
      types: [{ name: 'Table', defaults: { seating_capacity: 4 }, codes: ['T1', 'T2'] }],
    } });
  });

  const slot = (start_time, extra = {}) => ({ service_type: 'restaurant', date: '2027-05-05', start_time, people: 2, ...extra });

  it('allows exactly one of many simultaneous confirmations for the last table', async () => {
    await book(biz.business, slot('19:00', { resource_id: biz.resources.T2 }));
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
      book(biz.business, slot('19:00'), { customer: guest(`Racer ${index}`, `08100000${String(index).padStart(2, '0')}`) })));
    const won = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const lost = attempts.filter((attempt) => attempt.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(11);
    expect(lost.every((attempt) => attempt.reason.code === 'conflict')).toBe(true);
    const holding = await query(
      `SELECT COUNT(*)::int AS n FROM bookings WHERE resource_id = $1 AND status = 'confirmed'`, [biz.resources.T1]);
    expect(holding.rows[0].n).toBe(1);
  });

  it('is protected by a database constraint even if application checks are bypassed', async () => {
    const { reservation } = await book(biz.business, slot('12:00', { resource_id: biz.resources.T1 }));
    const row = await bookingRow(reservation.id);
    await expect(query(
      `INSERT INTO bookings (business_id, session_id, service_type, resource_id, status, hold_period)
       VALUES ($1, 'raw', 'restaurant', $2, 'confirmed', $3)`, [biz.business.id, row.resource_id, row.hold_period]))
      .rejects.toMatchObject({ code: '23P01' });
  });

  it('returns the original reservation for a retried or double-clicked request', async () => {
    const key = idem('retry');
    const first = await book(biz.business, slot('20:00'), { idempotency_key: key });
    const [again, andAgain] = await Promise.all([
      book(biz.business, slot('20:00'), { idempotency_key: key }),
      book(biz.business, slot('20:00'), { idempotency_key: key }),
    ]);
    expect(again.reservation.id).toBe(first.reservation.id);
    expect(andAgain.reservation.id).toBe(first.reservation.id);
    expect(again.idempotent_replay).toBe(true);
    expect((await query('SELECT COUNT(*)::int AS n FROM bookings')).rows[0].n).toBe(1);
    // The same key cannot be reused for a different request.
    await expectError(book(biz.business, slot('21:00'), { idempotency_key: key }), 'idempotency_conflict');
  });

  it('leaves the original booking untouched when a modification fails', async () => {
    const mine = await book(biz.business, slot('18:00', { resource_id: biz.resources.T1 }));
    await book(biz.business, slot('19:00', { resource_id: biz.resources.T1 }));
    const before = await bookingRow(mine.reservation.id);

    const err = await expectError(booking.modifyReservation(biz.business, mine.reservation.id, { start_time: '19:00' }, {}, biz.actor), 'conflict');
    expect(err.details.unchanged).toBe(true);
    const after = await bookingRow(mine.reservation.id);
    expect(after).toEqual(before);

    // Staff may explicitly allow moving to another table.
    const moved = await booking.modifyReservation(biz.business, mine.reservation.id, { start_time: '19:00' }, { allow_reassign: true }, biz.actor);
    expect(moved.reservation).toMatchObject({ status: 'modified', start_time: '19:00:00' });
    expect(moved.reservation.resource.code).toBe('T2');
  });

  it('protects resource reassignment with the same checks', async () => {
    const a = await book(biz.business, slot('13:00', { resource_id: biz.resources.T1 }));
    await book(biz.business, slot('13:00', { resource_id: biz.resources.T2 }));
    const err = await expectError(booking.modifyReservation(biz.business, a.reservation.id, { resource_id: biz.resources.T2 }, {}, biz.actor), 'conflict');
    expect(err.details.unchanged).toBe(true);
    expect(Number((await bookingRow(a.reservation.id)).resource_id)).toBe(biz.resources.T1);
  });

  it('asks for the terms to be accepted again when the quote changed before confirmation', async () => {
    const { updateType } = await import('../../platform/inventory.js');
    const shown = await booking.checkAvailability(biz.business, slot('17:00'));
    await updateType(biz.business, biz.types.Table.id, { defaults: { seating_capacity: 4, min_spend: '1200' } }, biz.actor);
    const err = await expectError(book(biz.business, slot('17:00'), { channel: 'chat', accepted_quote_hash: shown.selected.quote.hash }), 'quote_changed');
    expect(err.details.quote.minimum_spend).toBe('1200.00');
    expect((await query('SELECT COUNT(*)::int AS n FROM bookings')).rows[0].n).toBe(0);
    const accepted = await book(biz.business, slot('17:00'), { channel: 'chat', accepted_quote_hash: err.details.quote.hash });
    expect(accepted.reservation.status).toBe('confirmed');
  });
});
