// The AI receptionist flow end to end on real PostgreSQL: drafts hold nothing,
// confirmation re-checks under lock, prices and policies come from the backend.
import request from 'supertest';
import { resetDb, closeDb, makeBusiness, idem } from '../helpers/db.js';
import { loadApp, llmBooking } from '../helpers/app.js';
import { query } from '../../services/db.js';
import { updateType } from '../../platform/inventory.js';

// Mocks must be registered before anything imports the booking layer.
const ctx = await loadApp();
const booking = await import('../../booking/service.js');
const { app, mockChat, mockNotify } = ctx;

let biz;
const count = async (where = 'TRUE') => (await query(`SELECT COUNT(*)::int AS n FROM bookings WHERE ${where}`)).rows[0].n;

async function say(sessionId, message, slug = 'lumiere') {
  const res = await request(app).post('/api/chat').send({ session_id: sessionId, message, business: slug });
  expect(res.status).toBe(200);
  return res.body;
}
async function confirm(sessionId, token, body = {}, slug = 'lumiere') {
  const res = await request(app).post('/api/chat/confirm').set('X-Session-Id', sessionId).set('X-Session-Token', token)
    .send({ session_id: sessionId, business: slug, action: 'confirm', ...body });
  expect(res.status).toBe(200);
  return res.body;
}

const dinner = (overrides = {}) => llmBooking('book_restaurant', { service_type: 'restaurant', date: '05-05-2027', start_time: '19:00',
  people: 6, reservation_name: 'Avery Stone', phone_number: '0812345678', ...overrides });

beforeEach(async () => {
  await resetDb();
  ctx.resetMocks();
  biz = await makeBusiness({ slug: 'lumiere', restaurant: {
    settings: { default_duration_minutes: 90, turnover_buffer_minutes: 0 },
    types: [{ name: 'Private table', defaults: { seating_capacity: 8, seating_area: 'private', min_spend: '3000',
      deposit: { type: 'fixed', amount: '500' } }, codes: ['P01'] }],
  } });
});
afterAll(closeDb);

describe('new booking through chat', () => {
  it('quotes backend terms, holds nothing while drafting, and books only on explicit confirmation', async () => {
    mockChat.mockResolvedValueOnce(dinner());
    const reply = await say('s1', 'Dinner for six on 5 May 2027 at 7pm, Avery Stone, 0812345678');

    expect(reply.requires_confirmation).toBe(true);
    expect(reply.message).toContain('minimum spend of 3000.00 THB');
    expect(reply.message).toContain('deposit of 500.00 THB');
    expect(reply.message).toContain('Shall I go ahead and confirm this for you?');
    expect(reply.availability).toMatchObject({ waitlist: false, source: 'internal' });
    expect(reply.availability.freshness.authoritative).toBe(true);
    expect(reply.data.id).toBeUndefined();
    // The conversational draft reserved nothing.
    expect(await count()).toBe(0);

    const done = await confirm('s1', reply.session_token);
    expect(done).toMatchObject({ success: true, confirmed: true, status: 'confirmed' });
    expect(done.message).toContain('deposit of 500 THB is still due');
    const row = (await query('SELECT * FROM bookings')).rows[0];
    expect(row).toMatchObject({ status: 'confirmed', waitlisted: false, channel: 'chat', people: 6, reservation_name: 'Avery Stone',
      session_id: 's1', deposit_status: 'due' });
    expect(Number(row.min_spend_amount)).toBe(3000);
    expect(Number(row.business_id)).toBe(Number(biz.business.id));
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][0]).toMatchObject({ type: 'confirm', businessId: biz.business.id });
  });

  it('does not create a second reservation or a second notification on a double-clicked confirmation', async () => {
    mockChat.mockResolvedValueOnce(dinner());
    const reply = await say('s1', 'Dinner for six');
    const [first, second] = await Promise.all([confirm('s1', reply.session_token), confirm('s1', reply.session_token)]);
    expect([first.success, second.success]).toEqual([true, true]);
    expect(first.booking_id).toBe(second.booking_id);
    expect(await count()).toBe(1);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('explains when the option was taken before confirmation, books nothing, and offers the waitlist', async () => {
    mockChat.mockResolvedValueOnce(dinner());
    const reply = await say('s1', 'Dinner for six');
    // Someone else takes the only table between the quote and the confirmation.
    await booking.createReservation(biz.business, { service_type: 'restaurant', date: '2027-05-05', start_time: '19:00', people: 4,
      idempotency_key: idem(), customer: { name: 'Walk Up' }, channel: 'phone' }, biz.actor);

    const failed = await confirm('s1', reply.session_token);
    expect(failed).toMatchObject({ success: false, code: 'unavailable' });
    expect(failed.message).toMatch(/taken while we were talking/);
    expect(failed.message).toMatch(/nothing has been booked/);
    expect(failed.alternative).toMatchObject({ recommendation_type: 'time' });
    expect(await count(`session_id = 's1'`)).toBe(0);

    // The guest chooses the waitlist explicitly; it is clearly not a confirmed booking.
    const waitlisted = await confirm('s1', reply.session_token);
    expect(waitlisted).toMatchObject({ success: true, confirmed: false, status: 'waitlisted' });
    expect(waitlisted.message).toMatch(/not a confirmed booking/);
    const row = (await query(`SELECT * FROM bookings WHERE session_id = 's1'`)).rows[0];
    expect(row).toMatchObject({ waitlisted: true, status: 'pending', resource_id: null, hold_period: null });
  });

  it('asks the customer to confirm again when the price or policy changed after the quote', async () => {
    mockChat.mockResolvedValueOnce(dinner());
    const reply = await say('s1', 'Dinner for six');
    await updateType(biz.business, biz.types['Private table'].id,
      { defaults: { seating_capacity: 8, seating_area: 'private', min_spend: '4500', deposit: { type: 'fixed', amount: '500' } } }, biz.actor);

    const changed = await confirm('s1', reply.session_token);
    expect(changed).toMatchObject({ success: false, code: 'quote_changed', requires_confirmation: true });
    expect(changed.message).toContain('minimum spend of 4500.00 THB');
    expect(await count()).toBe(0);

    const accepted = await confirm('s1', reply.session_token);
    expect(accepted).toMatchObject({ success: true, confirmed: true });
    expect(Number((await query('SELECT min_spend_amount FROM bookings')).rows[0].min_spend_amount)).toBe(4500);
  });

  it('enforces capacity and enabled services in backend code regardless of what the model says', async () => {
    mockChat.mockResolvedValueOnce(dinner({ people: 20 }));
    const tooBig = await say('s1', 'Dinner for twenty');
    expect(tooBig.requires_confirmation).toBe(false);
    expect(tooBig.message).toMatch(/large enough/);
    expect(tooBig.data.draft).toBeNull();

    // The model claims a hotel booking; this business only offers a restaurant.
    mockChat.mockResolvedValueOnce(llmBooking('book_hotel', { service_type: 'hotel', date: '05-05-2027', end_date: '07-05-2027', people: 2,
      reservation_name: 'Avery Stone', phone_number: '0812345678' }));
    const hotel = await say('s2', 'I need a hotel room for two nights');
    expect(hotel.requires_confirmation).toBe(false);
    expect(hotel.message).toMatch(/don't take hotel room reservations here/);
    const refused = await confirm('s2', hotel.session_token);
    expect(refused.success).toBe(false);
    expect(await count()).toBe(0);
  });

  it('tells the model which services exist but never trusts it for availability', async () => {
    mockChat.mockResolvedValueOnce(dinner());
    await say('s1', 'Dinner for six');
    const context = mockChat.mock.calls[0][4];
    expect(context).toContain('Bookable services right now: restaurant');
    expect(context).toContain('Never state prices, availability');
  });
});

describe('guest sessions are bound to one business', () => {
  let other;
  beforeEach(async () => {
    other = await makeBusiness({ slug: 'rival', restaurant: { types: [{ name: 'Table', defaults: { seating_capacity: 8 }, codes: ['P01'] }] } });
  });

  it('rejects a session token issued by another business', async () => {
    mockChat.mockResolvedValueOnce(dinner());
    const reply = await say('s1', 'Dinner for six', 'lumiere');
    const stolen = await request(app).post('/api/chat/confirm').set('X-Session-Id', 's1').set('X-Session-Token', reply.session_token)
      .send({ session_id: 's1', business: 'rival', action: 'confirm' });
    expect(stolen.status).toBe(401);
    const read = await request(app).get('/api/bookings/s1').query({ business: 'rival' })
      .set('X-Session-Id', 's1').set('X-Session-Token', reply.session_token);
    expect(read.status).toBe(401);
    expect(await count()).toBe(0);
  });

  it('never finds, alters or cancels a reservation that belongs to another business', async () => {
    const theirs = await booking.createReservation(other.business, { service_type: 'restaurant', date: '2027-05-05', start_time: '19:00',
      people: 2, idempotency_key: idem(), customer: { name: 'Avery Stone', phone: '0812345678' }, channel: 'chat', session_id: 's1',
      accepted_quote_hash: (await booking.checkAvailability(other.business, { service_type: 'restaurant', date: '2027-05-05', start_time: '19:00', people: 2 })).selected.quote.hash }, other.actor);

    // Same session id, same name, same phone — but asked of a different business.
    const lookup = await say('s1', 'Cancel my restaurant reservation on 05-05-2027 under the name Avery Stone, phone 0812345678', 'lumiere');
    expect(lookup.data.edit_booking_id).toBeUndefined();
    expect(lookup.show_cancel_confirm).toBeUndefined();
    const attempt = await confirm('s1', lookup.session_token, { action: 'cancel', booking_id: theirs.reservation.id }, 'lumiere');
    expect(attempt.success).toBe(false);
    expect((await query('SELECT status FROM bookings WHERE id = $1', [theirs.reservation.id])).rows[0].status).toBe('confirmed');

    const mine = await request(app).get('/api/bookings/s1').query({ business: 'lumiere' })
      .set('X-Session-Id', 's1').set('X-Session-Token', lookup.session_token);
    expect(mine.body).toEqual([]);
  });

  it('requires a business identifier once more than one business accepts bookings', async () => {
    const res = await request(app).post('/api/chat').send({ session_id: 's1', message: 'hello' });
    expect(res.status).toBe(404);
  });
});
