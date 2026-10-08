// Business-local dates, overnight schedules and daylight-saving boundaries.
import { resetDb, closeDb, makeBusiness, idem } from '../helpers/db.js';
import { loadApp } from '../helpers/app.js';
import { zonedToInstant, zonedParts, localDayBounds, todayKey } from '../../platform/time.js';

const ctx = await loadApp();
const booking = await import('../../booking/service.js');
const create = (business, request) => booking.createReservation(business, { idempotency_key: idem(), customer: { name: 'Guest' }, channel: 'staff', ...request });

beforeEach(async () => { await resetDb(); ctx.resetMocks(); });
afterAll(closeDb);

describe('time helpers', () => {
  it('converts local wall time through both daylight-saving transitions', () => {
    // US clocks spring forward at 02:00 on 14 March 2027: 02:30 does not exist.
    expect(zonedToInstant('2027-03-14', 150, 'America/New_York').valid).toBe(false);
    expect(zonedToInstant('2027-03-14', 90, 'America/New_York').instant.toISOString()).toBe('2027-03-14T06:30:00.000Z');
    expect(zonedToInstant('2027-03-14', 210, 'America/New_York').instant.toISOString()).toBe('2027-03-14T07:30:00.000Z');
    // Clocks fall back on 7 November 2027: 01:30 happens twice; the first one is used.
    expect(zonedToInstant('2027-11-07', 90, 'America/New_York')).toEqual({ instant: new Date('2027-11-07T05:30:00.000Z'), valid: true });
  });

  it('measures a business-local day correctly when it is 23 or 25 hours long', () => {
    const hours = (day) => { const { start, end } = localDayBounds(day, 'America/New_York'); return (end - start) / 3600000; };
    expect(hours('2027-03-14')).toBe(23);
    expect(hours('2027-11-07')).toBe(25);
    expect(hours('2027-06-01')).toBe(24);
  });

  it('uses the business\'s own calendar date, not the server\'s or UTC', () => {
    const instant = new Date('2027-01-01T11:30:00Z');
    expect(todayKey('Pacific/Auckland', instant)).toBe('2027-01-02');
    expect(todayKey('America/Los_Angeles', instant)).toBe('2027-01-01');
    expect(zonedParts(instant, 'Asia/Kolkata').time).toBe('17:00');
  });
});

describe('bookings across daylight-saving changes', () => {
  let biz;
  beforeEach(async () => {
    biz = await makeBusiness({ slug: 'nyc', timezone: 'America/New_York', currency: 'USD',
      hotel: { types: [{ name: 'Queen', defaults: { max_guests: 2, base_rate: '200.00' }, codes: ['201'] }] },
      restaurant: { settings: { default_duration_minutes: 90, turnover_buffer_minutes: 0,
        operating_hours: { sat: [{ open: '18:00', close: '03:00' }], sun: [{ open: '17:00', close: '23:00' }] } },
        types: [{ name: 'Table', defaults: { seating_capacity: 4 }, codes: ['T1'] }] } });
  });

  it('keeps hotel dates as local calendar dates and charges per night across the spring change', async () => {
    const { reservation } = await create(biz.business, { service_type: 'hotel', date: '2027-03-13', end_date: '2027-03-15', people: 2 });
    expect(reservation).toMatchObject({ date: '2027-03-13', end_date: '2027-03-15', total_amount: '400', currency: 'USD' });
    // 14:00 EST (UTC-5) to 11:00 EDT (UTC-4).
    expect(new Date(reservation.starts_at).toISOString()).toBe('2027-03-13T19:00:00.000Z');
    expect(new Date(reservation.ends_at).toISOString()).toBe('2027-03-15T15:00:00.000Z');
    // The next guest can still arrive on the checkout date.
    expect((await create(biz.business, { service_type: 'hotel', date: '2027-03-15', end_date: '2027-03-16', people: 2 })).reservation.status).toBe('confirmed');
  });

  it('rejects a local time that the clock change skips', async () => {
    // Saturday night service runs past midnight into the skipped hour.
    const err = await create(biz.business, { service_type: 'restaurant', date: '2027-03-14', start_time: '02:30', people: 2 }).then(() => null, (caught) => caught);
    expect(err.code).toBe('validation');
    expect(err.message).toMatch(/does not exist/);
  });

  it('keeps a sitting its real length through the autumn change, inside an overnight service period', async () => {
    // Saturday 6 Nov service runs 18:00 → 03:00 Sunday; clocks repeat 01:00–02:00.
    const { reservation } = await create(biz.business, { service_type: 'restaurant', date: '2027-11-07', start_time: '00:30', people: 2 });
    const minutes = (new Date(reservation.ends_at) - new Date(reservation.starts_at)) / 60000;
    expect(minutes).toBe(90);
    // 90 real minutes from 00:30 EDT ends at 01:00 EST on the wall clock.
    expect(reservation).toMatchObject({ date: '2027-11-07', start_time: '00:30:00', end_time: '01:00:00' });
    // The period really is 10 hours long that night, so 02:30 EST is still inside it…
    const late = await booking.checkAvailability(biz.business, { service_type: 'restaurant', date: '2027-11-07', start_time: '02:30', end_time: '03:00', people: 2 });
    expect(late.selected).not.toBeNull();
    // …and overlapping real time on the same table is still refused.
    const overlap = await booking.checkAvailability(biz.business, { service_type: 'restaurant', date: '2027-11-07', start_time: '00:45', people: 2 });
    expect(overlap.reason.code).toBe('full');
  });

  it('applies closure dates in the business calendar', async () => {
    const { query } = await import('../../services/db.js');
    await query(`INSERT INTO closures (business_id, service_type, start_date, end_date, reason) VALUES ($1, NULL, '2027-12-24', '2027-12-25', 'Holiday')`, [biz.business.id]);
    const stay = await booking.checkAvailability(biz.business, { service_type: 'hotel', date: '2027-12-23', end_date: '2027-12-25', people: 2 });
    expect(stay.reason.code).toBe('closed');
    const before = await booking.checkAvailability(biz.business, { service_type: 'hotel', date: '2027-12-22', end_date: '2027-12-24', people: 2 });
    expect(before.selected).not.toBeNull();
  });
});
