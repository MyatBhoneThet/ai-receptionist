// Chat and voice regression scenarios carried over from the pre-platform suite.
// They used to run against a hand-written SQL-string mock; they now run against
// real PostgreSQL through tests/helpers/legacyHarness.js, with only the language
// model, Google Calendar and notifications mocked.
import { jest } from '@jest/globals';
import { loadApp } from '../helpers/app.js';
import { createLegacyHarness } from '../helpers/legacyHarness.js';

const ctx = await loadApp({ spyDb: true });
const { app, mockChat, mockUpsertEvent, mockCalendarEnabled, mockGetEventStatus, mockCancelEvent, dbSpy: query } = ctx;
const h = createLegacyHarness(ctx);

const defaultChatResponse = { message: 'ok', speak: 'ok', intent: 'unknown', data: {}, missing_fields: [], confidence: 1 };
const normalizeSql = (sql) => sql.replace(/\s+/g, ' ').trim().toLowerCase();
const cloneRow = (row) => ({ ...row });

function makeInitialBookings() {
  return [
    { id: 1, session_id: 'sess-1', service_type: 'hotel', date: '2027-04-07', start_time: '14:00:00', end_time: '11:00:00',
      reservation_name: 'Avery', people: 2, notes: '', status: 'pending', waitlisted: false, contact_email: 'avery@example.com',
      contact_phone: '0800123456', created_at: new Date('2027-04-01T00:00:00Z'), updated_at: new Date('2027-04-01T00:00:00Z') },
    { id: 2, session_id: 'sess-2', service_type: 'restaurant', date: '2027-04-08', start_time: '18:30:00', end_time: '19:30:00',
      reservation_name: 'Jordan', people: 4, notes: '', status: 'confirmed', waitlisted: false, contact_email: 'jordan@example.com',
      contact_phone: '0800111222', created_at: new Date('2027-04-02T00:00:00Z'), updated_at: new Date('2027-04-02T00:00:00Z') },
  ];
}

afterAll(() => h.close());

describe('route flows', () => {
  beforeEach(async () => {
    await h.reset(makeInitialBookings());
    ctx.resetMocks();
    mockChat.mockResolvedValue(defaultChatResponse);
    mockCalendarEnabled.mockReturnValue(true);
    query.mockClear();
  });

  it('registers, logs in, and returns the current user', async () => {
    const registerRes = await h.request()
      .post('/api/users/register')
      .send({
        email: 'guest@example.com',
        password: 'supersecret',
        name: 'Guest',
        phone_number: '0800000000',
      });

    expect(registerRes.status).toBe(200);
    expect(registerRes.body.user.email).toBe('guest@example.com');
    expect(registerRes.headers['set-cookie']).toBeDefined();

    const loginRes = await h.request()
      .post('/api/users/login')
      .send({
        email: 'guest@example.com',
        password: 'supersecret',
      });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.token).toBeTruthy();

    const meRes = await h.request()
      .get('/api/users/me')
      .set('Authorization', `Bearer ${loginRes.body.token}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.email).toBe('guest@example.com');
  });

  it('recommends another place when the requested meeting room is occupied', async () => {
    h.state.inventory.push(
      { id: 101, category: 'meeting', code: 'BOARDROOM', name: 'Executive Boardroom', capacity: 12, quantity: 1, metadata: {} },
      { id: 102, category: 'meeting', code: 'MEET-10', name: 'Meeting Room 10p', capacity: 10, quantity: 1, metadata: {} }
    );
    h.state.bookings.push({
      id: 101,
      session_id: 'sess-occupied',
      service_type: 'meeting',
      date: '2027-06-12',
      start_time: '10:00:00',
      end_time: '11:00:00',
      reservation_name: 'Existing',
      people: 6,
      status: 'confirmed',
      waitlisted: false,
      inventory_id: 101,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const sessionToken = h.sessionToken('sess-availability');
    const res = await h.request()
      .post('/api/availability/check')
      .set('X-Session-Id', 'sess-availability')
      .set('X-Session-Token', sessionToken)
      .send({
        service_type: 'meeting',
        date: '12-06-2027',
        start_time: '10:00',
        end_time: '11:00',
        people: 6,
        preferred_inventory: 'boardroom',
      });

    expect(res.status).toBe(200);
    expect(res.body.waitlist).toBe(true);
    expect(res.body.occupied_option.name).toBe('Executive Boardroom');
    expect(res.body.place_recommendation.name).toBe('Meeting Room 10p');
  });

  it('recommends the nearest available hotel day when all 100 rooms are booked for a week', async () => {
    for (let floor = 1; floor <= 10; floor += 1) {
      h.state.inventory.push({
        id: floor,
        category: 'room',
        code: `FLOOR-${String(floor).padStart(2, '0')}`,
        name: `Floor ${floor} Rooms`,
        capacity: 4,
        quantity: 10,
        metadata: { floor, rooms_per_floor: 10 },
      });
    }

    for (let i = 0; i < 100; i += 1) {
      h.state.bookings.push({
        id: 3000 + i,
        session_id: `sess-full-hotel-${i}`,
        service_type: 'hotel',
        date: '2027-07-13',
        end_date: '2027-07-20',
        start_time: '14:00:00',
        end_time: '11:00:00',
        reservation_name: `Guest ${i}`,
        people: 2,
        // Each stay occupies its own physical room (floor i/10, room i%10).
        hotel_room_id: (Math.floor(i / 10) + 1) * 1000 + (i % 10) + 1,
        status: 'confirmed',
        waitlisted: false,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }

    mockChat.mockResolvedValueOnce({
      message: 'I can help with that hotel booking.',
      speak: 'I can help with that hotel booking.',
      intent: 'book_hotel',
      data: {
        service_type: 'hotel',
        date: '13-07-2027',
        end_date: '20-07-2027',
        start_time: '',
        end_time: '',
        people: 2,
        notes: '',
        reservation_name: 'Alex',
        phone_number: '0800100200',
      },
      missing_fields: [],
      confidence: 1,
    });

    const res = await h.request()
      .post('/api/chat')
      .send({
        session_id: 'sess-hotel-overflow',
        message: 'Book a room for Alex next week',
      });

    expect(res.status).toBe(200);
    expect(res.body.availability.waitlist).toBe(true);
    expect(res.body.availability.alternative.recommendation_type).toBe('date');
    expect(res.body.availability.alternative.date).toBe('20-07-2027');
    expect(res.body.availability.alternative.available).toBeGreaterThan(0);
  });

  it('recommends the nearest restaurant time when every suitable table is booked at the requested time', async () => {
    const tables = [
      { id: 401, code: 'T01', name: 'Table 1 - two guests', capacity: 2 },
      { id: 402, code: 'T02', name: 'Table 2 - two guests', capacity: 2 },
      { id: 403, code: 'T03', name: 'Table 3 - four guests', capacity: 4 },
      { id: 404, code: 'T04', name: 'Table 4 - four guests', capacity: 4 },
      { id: 405, code: 'T05', name: 'Table 5 - four guests', capacity: 4 },
      { id: 406, code: 'T06', name: 'Table 6 - six guests', capacity: 6 },
      { id: 407, code: 'T07', name: 'Table 7 - six guests', capacity: 6 },
      { id: 408, code: 'T08', name: 'Table 8 - eight guests', capacity: 8 },
      { id: 409, code: 'T09', name: 'Table 9 - ten guests', capacity: 10 },
    ];
    h.state.inventory.push(
      ...tables.map((table) => ({
        ...table,
        category: 'table',
        quantity: 1,
        metadata: { table_number: table.code },
      }))
    );

    tables
      .filter((table) => table.capacity >= 5)
      .forEach((table, index) => {
        h.state.bookings.push({
          id: 4000 + index,
          session_id: `sess-table-full-${index}`,
          service_type: 'restaurant',
          date: '2027-07-14',
          start_time: '18:00:00',
          end_time: '19:00:00',
          reservation_name: `Dinner ${index}`,
          people: 5,
          status: 'confirmed',
          waitlisted: false,
          inventory_id: table.id,
          created_at: new Date(),
          updated_at: new Date(),
        });
      });

    mockChat.mockResolvedValueOnce({
      message: 'I can help with that dinner booking.',
      speak: 'I can help with that dinner booking.',
      intent: 'book_restaurant',
      data: {
        service_type: 'restaurant',
        date: '14-07-2027',
        start_time: '18:00',
        end_time: '19:00',
        people: 5,
        notes: '',
        reservation_name: 'Family Lee',
        phone_number: '0800100300',
      },
      missing_fields: [],
      confidence: 1,
    });

    const res = await h.request()
      .post('/api/chat')
      .send({
        session_id: 'sess-restaurant-overflow',
        message: 'Book dinner for a family of 5 at 6pm',
      });

    expect(res.status).toBe(200);
    expect(res.body.availability.waitlist).toBe(true);
    expect(res.body.availability.alternative.recommendation_type).toBe('time');
    expect(res.body.availability.alternative.start_time).toBe('19:00');
    expect(res.body.availability.alternative.available).toBeGreaterThan(0);
  });

  it('blocks exact duplicate bookings from chat', async () => {
    h.seedAlterationInventory();
    h.state.inventory.push({
      id: 201,
      category: 'table',
      code: 'TABLE-4',
      name: 'Table for 4',
      capacity: 4,
      quantity: 4,
      metadata: {},
    });
    h.state.bookings.push({
      id: 201,
      session_id: 'sess-original',
      service_type: 'restaurant',
      date: '2027-06-20',
      start_time: '19:00:00',
      end_time: '20:00:00',
      reservation_name: 'Nora',
      people: 4,
      status: 'confirmed',
      waitlisted: false,
      contact_phone: '0800123000',
      inventory_id: 201,
      created_at: new Date(),
      updated_at: new Date(),
    });

    mockChat.mockResolvedValueOnce({
      message: 'I can book that.',
      speak: 'I can book that.',
      intent: 'book_restaurant',
      data: {
        service_type: 'restaurant',
        date: '20-06-2027',
        start_time: '19:00',
        end_time: '20:00',
        people: 4,
        notes: '',
        reservation_name: 'Nora',
        phone_number: '0800123000',
      },
      missing_fields: [],
      confidence: 1,
    });

    const beforeCount = h.state.bookings.length;
    const res = await h.request()
      .post('/api/chat')
      .send({
        session_id: 'sess-duplicate',
        message: 'Book the same table again for Nora',
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain("won't create a duplicate");
    expect(h.state.bookings).toHaveLength(beforeCount);
  });

  describe('Google Calendar confirmation retries', () => {
    beforeEach(async () => {
      query.mockClear();
    });

    function confirm() {
      return h.request().post('/api/chat/confirm')
        .set('X-Session-Id', 'sess-2').set('X-Session-Token', h.sessionToken('sess-2'))
        .send({ session_id: 'sess-2', action: 'confirm' });
    }

    function statusWrites() {
      return query.mock.calls.filter(([sql]) => /^update bookings set status/.test(normalizeSql(sql)));
    }

    it('retries the same event for an already confirmed reservation without changing status or notifying twice', async () => {
      h.state.bookings[1].google_event_id = 'existing-event';
      mockUpsertEvent.mockResolvedValue('existing-event');

      const response = await confirm();

      expect(response.status).toBe(200);
      expect(response.body).toEqual(expect.objectContaining({ success: true, booking_id: 2, calendar_sync: { status: 'synced' } }));
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 2, status: 'confirmed', google_event_id: 'existing-event' }));
      expect(statusWrites()).toHaveLength(0);
      expect(ctx.mockNotify).not.toHaveBeenCalled();
      expect(h.state.bookings[1].status).toBe('confirmed');
    });

    it('creates a missing event on retry without writing the confirmed status again', async () => {
      mockUpsertEvent.mockResolvedValue('created-on-retry');

      const response = await confirm();

      expect(response.body.calendar_sync).toEqual({ status: 'synced' });
      expect(h.state.bookings[1].google_event_id).toBe('created-on-retry');
      expect(h.state.bookings[1].status).toBe('confirmed');
      expect(statusWrites()).toHaveLength(0);
      expect(ctx.mockNotify).not.toHaveBeenCalled();
    });

    it.each(['existing-event', null])('retains the confirmed reservation and its %s event ID when a retry fails', async (eventId) => {
      h.state.bookings[1].google_event_id = eventId;
      mockUpsertEvent.mockResolvedValue(null);

      const response = await confirm();

      expect(response.body).toEqual(expect.objectContaining({ success: true, calendar_sync: { status: 'failed' } }));
      expect(response.body.message).toContain('could not be updated');
      expect(h.state.bookings[1]).toEqual(expect.objectContaining({ status: 'confirmed', google_event_id: eventId }));
      expect(statusWrites()).toHaveLength(0);
      // Only Calendar bookkeeping may be written; the reservation itself is untouched.
      expect(query.mock.calls.filter(([sql]) => /^update bookings set (?!calendar_sync_status)/.test(normalizeSql(sql)))).toHaveLength(0);
    });
  });

  it('keeps reservation changes in edit mode instead of repeating the lookup', async () => {
    h.seedAlterationInventory();
    h.state.bookings.push({
      id: 3,
      session_id: 'sess-modify',
      service_type: 'meeting',
      date: '2027-05-15',
      start_time: '10:00:00',
      end_time: '11:00:00',
      reservation_name: 'Talia',
      people: 6,
      location: 'Room 4',
      notes: '',
      status: 'confirmed',
      waitlisted: false,
      contact_email: 'talia@example.com',
      contact_phone: '0800999000',
      created_at: new Date('2027-05-01T00:00:00Z'),
      updated_at: new Date('2027-05-01T00:00:00Z'),
    });

    const lookupRes = await h.request()
      .post('/api/chat')
      .send({
        session_id: 'sess-modify',
        message: 'I want to change my meeting reservation',
      });

    expect(lookupRes.status).toBe(200);
    expect(lookupRes.body.message).toContain('To find your booking');
    expect(lookupRes.body.missing_fields).toEqual(['reservation name']);

    const fieldRes = await h.request()
      .post('/api/chat')
      .send({
        session_id: 'sess-modify',
        message: 'it\'s on 15-05-2027 and name is Talia',
      });

    expect(fieldRes.status).toBe(200);
    expect(fieldRes.body.message).toContain('I\'ve found your meeting reservation');
    expect(fieldRes.body.intent).toBe('modify_booking');

    const chooseFieldRes = await h.request()
      .post('/api/chat')
      .send({
        session_id: 'sess-modify',
        message: 'date',
      });

    expect(chooseFieldRes.status).toBe(200);
    expect(chooseFieldRes.body.message).toContain('What date would you like instead?');

    const updateRes = await h.request()
      .post('/api/chat')
      .send({
        session_id: 'sess-modify',
        message: '18-05-2027',
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.message).toContain('updated your meeting reservation');
    expect(h.state.bookings.find((item) => item.id === 3).date).toBe('2027-05-18');

    const slipRes = await h.request()
      .post('/api/chat')
      .send({
        session_id: 'sess-modify',
        message: 'show me the reservation slip',
      });

    expect(slipRes.status).toBe(200);
    expect(slipRes.body.show_reservation_slip).toBe(true);
    expect(slipRes.body.data.people).toBe(6);
    expect(slipRes.body.message).toContain('You booked 6 guests');
  });

  describe('booking lookup corrections', () => {
    let fixtureNumber = 0;
    let sessionId;
    let originalBookings;

    beforeEach(async () => {
      sessionId = `sess-lookup-correction-${++fixtureNumber}`;
      h.state.bookings.push({
        id: 70,
        session_id: sessionId,
        service_type: 'meeting',
        date: '2026-10-14',
        start_time: '10:00:00',
        end_time: '11:00:00',
        reservation_name: 'Stewart',
        people: 6,
        notes: '',
        status: 'confirmed',
        waitlisted: false,
        contact_phone: '0801111111',
        google_event_id: 'existing-meeting-event',
        created_at: new Date('2026-10-01T00:00:00Z'),
        updated_at: new Date('2026-10-01T00:00:00Z'),
      });
      originalBookings = await h.snapshot();
      query.mockClear();
      // Simulate the stale model output that produced the screenshot's date/name drift.
      mockChat.mockResolvedValue({
        ...defaultChatResponse,
        intent: 'modify_booking',
        data: {
          service_type: 'hotel', date: '12-10-2026', reservation_name: 'Stuart',
          people: 99, phone_number: '0809999999',
        },
      });
    });

    async function send(message) {
      const response = await h.request().post('/api/chat').send({ session_id: sessionId, message });
      expect(response.status).toBe(200);
      return response;
    }

    async function startFailedLookup() {
      const response = await send('I want to change my meeting reservation on 14-10-2026 under the name Stuart');
      expect(response.body.message).toMatch(/phone/i);
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '14-10-2026', service_type: 'meeting', reservation_name: 'Stuart',
        modify_step: 'awaiting_verification',
      }));
      expect(response.body.data.edit_booking_id).toBeUndefined();
      expectLookupDidNotMutateBookings();
    }

    function expectLookupDidNotMutateBookings() {
      expect(h.state.bookings).toEqual(originalBookings);
      expect(mockUpsertEvent).not.toHaveBeenCalled();
      const bookingWrites = query.mock.calls.filter(([sql]) =>
        /^(?:insert into|update|delete from) bookings\b/.test(normalizeSql(sql))
      );
      expect(bookingWrites).toEqual([]);
    }

    it.each(['Stewart', 'The name is Stewart'])(
      'corrects the name with "%s" without changing the date or service',
      async (correction) => {
        await startFailedLookup();
        const response = await send(correction);
        expect(response.body.message).toContain("I've found your meeting reservation for 14-10-2026");
        expect(response.body.data).toEqual(expect.objectContaining({
          date: '14-10-2026', service_type: 'meeting', reservation_name: 'Stewart',
          edit_booking_id: 70, modify_step: 'choose_field', people: 6,
        }));
        expect(mockChat).not.toHaveBeenCalled();
        expectLookupDidNotMutateBookings();
      }
    );

    it.each(['May', 'Friday'])('does not treat the explicit name "%s" as a date correction', async (name) => {
      await startFailedLookup();
      const response = await send(`The name is ${name}`);
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '14-10-2026', service_type: 'meeting', reservation_name: name,
        modify_step: 'awaiting_verification',
      }));
      expect(mockChat).not.toHaveBeenCalled();
      expectLookupDidNotMutateBookings();
    });

    it('changes only the explicitly corrected date while retaining the lookup name and service', async () => {
      await startFailedLookup();
      const response = await send('Actually, 12-10-2026');
      expect(response.body.message).toMatch(/phone/i);
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '12-10-2026', service_type: 'meeting', reservation_name: 'Stuart',
        modify_step: 'awaiting_verification',
      }));
      expect(response.body.data.edit_booking_id).toBeUndefined();
      expect(mockChat).not.toHaveBeenCalled();
      expectLookupDidNotMutateBookings();
    });

    it('preserves the pending criteria when the user repeats a lookup without supplying new details', async () => {
      await startFailedLookup();
      const response = await send('Find my reservation');
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '14-10-2026', service_type: 'meeting', reservation_name: 'Stuart',
        modify_step: 'awaiting_verification',
      }));
      expect(response.body.message).toMatch(/phone/i);
      expect(mockChat).not.toHaveBeenCalled();
      expectLookupDidNotMutateBookings();
    });

    it('fills a missing reservation type without starting a new booking or losing the date/name', async () => {
      const incomplete = await send('I want to change my reservation on 14-10-2026 under the name Stewart');
      expect(incomplete.body.missing_fields).toEqual(['type of reservation']);
      expect(incomplete.body.data.modify_step).toBe('awaiting_lookup');
      expectLookupDidNotMutateBookings();

      const response = await send('meeting');
      expect(response.body.message).toContain("I've found your meeting reservation for 14-10-2026");
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '14-10-2026', service_type: 'meeting', reservation_name: 'Stewart',
        edit_booking_id: 70, modify_step: 'choose_field',
      }));
      expect(mockChat).not.toHaveBeenCalled();
      expectLookupDidNotMutateBookings();
    });
  });

  describe('reservation type understanding', () => {
    let fixtureNumber = 0;
    let sessionId;
    let originalBookings;
    const originalTimezone = process.env.CALENDAR_TIMEZONE;

    beforeEach(async () => {
      process.env.CALENDAR_TIMEZONE = 'Asia/Bangkok';
      jest.useFakeTimers({
        now: new Date('2026-10-05T07:00:00Z'),
        doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'hrtime', 'performance', 'queueMicrotask'],
      });
      sessionId = `sess-service-understanding-${++fixtureNumber}`;
      h.state.bookings.push({
        id: 80,
        session_id: sessionId,
        service_type: 'meeting',
        date: '2026-10-14',
        start_time: '10:00:00',
        end_time: '11:00:00',
        reservation_name: 'Steward',
        people: 6,
        notes: '',
        status: 'confirmed',
        waitlisted: false,
        contact_phone: '0801111111',
        google_event_id: 'existing-meeting-event',
        created_at: new Date('2026-10-01T00:00:00Z'),
        updated_at: new Date('2026-10-01T00:00:00Z'),
      });
      originalBookings = await h.snapshot();
      query.mockClear();
      // An incorrect model reconstruction must not override explicit user criteria.
      mockChat.mockResolvedValue({
        ...defaultChatResponse,
        intent: 'book_restaurant',
        data: { service_type: 'restaurant', date: '12-10-2026', reservation_name: 'Stuart', people: 2 },
      });
    });

    afterEach(() => {
      jest.useRealTimers();
      if (originalTimezone === undefined) delete process.env.CALENDAR_TIMEZONE;
      else process.env.CALENDAR_TIMEZONE = originalTimezone;
    });

    async function send(message) {
      const response = await h.request().post('/api/chat').send({ session_id: sessionId, message });
      expect(response.status).toBe(200);
      return response;
    }

    function expectNoBookingChanges() {
      expect(h.state.bookings).toEqual(originalBookings);
      expect(mockUpsertEvent).not.toHaveBeenCalled();
      expect(query.mock.calls.filter(([sql]) =>
        /^(?:insert into|update|delete from) bookings\b/.test(normalizeSql(sql))
      )).toEqual([]);
    }

    function expectMeetingFound(response) {
      expect(response.body.intent).toBe('modify_booking');
      expect(response.body.data).toEqual(expect.objectContaining({
        service_type: 'meeting', date: '14-10-2026', reservation_name: 'Steward',
        edit_booking_id: 80, modify_step: 'choose_field',
      }));
      expect(mockChat).not.toHaveBeenCalled();
      expectNoBookingChanges();
    }

    it.each(['alter', 'amend'])(
      'starts an existing-reservation lookup for "%s a booking" without asking the model',
      async (verb) => {
        const response = await send(`I would like to ${verb} a booking`);
        expect(response.body.intent).toBe('modify_booking');
        expect(response.body.data.modify_step).toBe('awaiting_lookup');
        expect(response.body.missing_fields).toEqual(['type of reservation', 'reservation name']);
        expect(mockChat).not.toHaveBeenCalled();
        expectNoBookingChanges();
      }
    );

    it('uses the explicitly stated meeting type in the screenshot sentence, despite the word table', async () => {
      await send('I would like to alter a booking');
      const response = await send('The date is next Wednesday and the table reservation is meeting and the name is Steward');
      expectMeetingFound(response);
    });

    it.each(['meeting room', 'conference room', 'boardroom'])(
      'recognizes a %s reservation as a meeting rather than a hotel stay',
      async (service) => {
        const response = await send(`Find my ${service} reservation on 14-10-2026 under the name Steward`);
        expectMeetingFound(response);
      }
    );

    it.each([
      'the type of reservation is meeting, not booking',
      'meeting, not restaurant',
      'meeting, not a restaurant',
      'not restaurant, meeting',
    ])('corrects only the type with "%s" while keeping the date and name', async (correction) => {
      const failed = await send('I want to change my restaurant reservation on 14-10-2026 under the name Steward');
      expect(failed.body.data).toEqual(expect.objectContaining({
        service_type: 'restaurant', date: '14-10-2026', reservation_name: 'Steward',
        modify_step: 'awaiting_verification',
      }));
      expect(failed.body.data.edit_booking_id).toBeUndefined();
      const response = await send(correction);
      expectMeetingFound(response);
    });

    it('respects an explicit restaurant label when meeting is only incidental context', async () => {
      const restaurant = { ...h.state.bookings.find((booking) => booking.id === 80), id: 81, service_type: 'restaurant' };
      h.state.bookings.push(restaurant);
      originalBookings = await h.snapshot();
      const response = await send('I want to amend my booking on 14-10-2026 and the reservation type is restaurant for a meeting with colleagues and the name is Steward');
      expect(response.body.data).toEqual(expect.objectContaining({
        service_type: 'restaurant', date: '14-10-2026', reservation_name: 'Steward',
        edit_booking_id: 81, modify_step: 'choose_field',
      }));
      expect(mockChat).not.toHaveBeenCalled();
      expectNoBookingChanges();
    });

    it('asks for clarification when unlabelled reservation types conflict instead of choosing one', async () => {
      const response = await send('I want to alter my hotel or restaurant reservation on 14-10-2026 under the name Steward');
      expect(response.body.intent).toBe('modify_booking');
      expect(response.body.missing_fields).toEqual(['type of reservation']);
      expect(response.body.data).toEqual(expect.objectContaining({
        service_type: '', date: '14-10-2026', reservation_name: 'Steward', modify_step: 'awaiting_lookup',
      }));
      expect(response.body.data.edit_booking_id).toBeUndefined();
      expect(mockChat).not.toHaveBeenCalled();
      expectNoBookingChanges();
      expectMeetingFound(await send('meeting'));
    });

    it('does not silently retain the previous type when a follow-up introduces conflicting types', async () => {
      await send('I want to change my restaurant reservation on 14-10-2026 under the name Steward');
      const response = await send('hotel or restaurant');
      expect(response.body.missing_fields).toEqual(['type of reservation']);
      expect(response.body.data).toEqual(expect.objectContaining({
        service_type: '', date: '14-10-2026', reservation_name: 'Steward', modify_step: 'awaiting_lookup',
      }));
      expect(response.body.data.edit_booking_id).toBeUndefined();
      expect(mockChat).not.toHaveBeenCalled();
      expectNoBookingChanges();
      expectMeetingFound(await send('meeting'));
    });
  });

  describe('reservation recovery across conversations', () => {
    let fixtureNumber = 0;
    let sessionId;
    let originalBookings;

    beforeEach(async () => {
      h.seedAlterationInventory();
      sessionId = `sess-recovery-${++fixtureNumber}`;
      h.state.bookings.push({
        id: 90,
        session_id: `sess-original-${fixtureNumber}`,
        service_type: 'meeting',
        date: '2026-10-14',
        start_time: '09:00:00',
        end_time: '10:00:00',
        reservation_name: 'Steward',
        people: 7,
        notes: 'Original customer note',
        status: 'confirmed',
        waitlisted: false,
        contact_phone: '080-111-1111',
        contact_email: 'steward@example.com',
        google_event_id: 'recovered-meeting-event',
        created_at: new Date('2026-10-01T00:00:00Z'),
        updated_at: new Date('2026-10-01T00:00:00Z'),
      }, {
        id: 91,
        session_id: sessionId,
        service_type: 'restaurant',
        date: '2026-10-12',
        start_time: '18:00:00',
        end_time: '19:00:00',
        reservation_name: 'Other guest',
        people: 2,
        status: 'pending',
        waitlisted: false,
        contact_phone: '0802222222',
        created_at: new Date('2026-10-05T00:00:00Z'),
        updated_at: new Date('2026-10-05T00:00:00Z'),
      });
      originalBookings = await h.snapshot();
      query.mockClear();
    });

    async function send(message) {
      const response = await h.request().post('/api/chat').send({ session_id: sessionId, message });
      expect(response.status).toBe(200);
      return response;
    }

    async function startRecovery(action = 'alter') {
      return send(`I want to ${action} my meeting reservation on 14-10-2026 under the name Steward`);
    }

    function expectUnverified(response) {
      expect(response.body.data).toEqual(expect.objectContaining({
        service_type: 'meeting', date: '14-10-2026', reservation_name: 'Steward',
        modify_step: 'awaiting_verification',
      }));
      expect(response.body.missing_fields).toEqual(['phone number']);
      expect(response.body.data.id).toBeUndefined();
      expect(response.body.data.booking_id).toBeUndefined();
      expect(response.body.data.edit_booking_id).toBeUndefined();
      expect(response.body.show_cancel_confirm).not.toBe(true);
      expect(response.body.show_reservation_slip).not.toBe(true);
      expect(JSON.stringify(response.body)).not.toMatch(/080-111-1111|steward@example\.com|Original customer note|sess-original-/);
    }

    function expectNoBookingChanges() {
      expect(h.state.bookings).toEqual(originalBookings);
      expect(mockUpsertEvent).not.toHaveBeenCalled();
      expect(query.mock.calls.filter(([sql]) =>
        /^(?:insert into|update|delete from) bookings\b/.test(normalizeSql(sql))
      )).toEqual([]);
    }

    function expectRecovered(response) {
      expect(response.body.data).toEqual(expect.objectContaining({
        service_type: 'meeting', date: '14-10-2026', reservation_name: 'Steward',
        edit_booking_id: 90, modify_step: 'choose_field', people: 7,
      }));
      expect(response.body.data.session_id).toBeUndefined();
      expect(response.body.message).toContain("I've found your meeting reservation");
    }

    it('requests the original contact phone instead of denying a reservation from another conversation', async () => {
      expectUnverified(await startRecovery());
      expect(mockChat).not.toHaveBeenCalled();
      expect(query.mock.calls.filter(([sql]) => normalizeSql(sql).includes('regexp_replace'))).toEqual([]);
      expectNoBookingChanges();
    });

    it.each(['0801111111', '080 111 1111', 'The original phone number is 080-111-1111'])(
      'recovers exact criteria with the normalized original phone "%s"',
      async (phone) => {
        await startRecovery();
        expectRecovered(await send(phone));
        expect(mockChat).not.toHaveBeenCalled();
        expectNoBookingChanges();
      }
    );

    it('keeps the request unverified after the wrong phone without leaking customer details or changing bookings', async () => {
      await startRecovery();
      expectUnverified(await send('0809999999'));
      expect(mockChat).not.toHaveBeenCalled();
      expectNoBookingChanges();
      expectRecovered(await send('0801111111'));
    });

    it.each([
      ['meeting', '14-10-2026', 'Stuart', 'The name is Steward'],
      ['meeting', '12-10-2026', 'Steward', 'Actually, 14-10-2026'],
      ['restaurant', '14-10-2026', 'Steward', 'The reservation type is meeting'],
    ])('allows a %s/%s/%s criterion correction during verification', async (type, date, name, correction) => {
      await send(`I want to alter my ${type} reservation on ${date} under the name ${name}`);
      expectUnverified(await send(correction));
      expectRecovered(await send('0801111111'));
      expectNoBookingChanges();
    });

    it('offers a choice instead of silently choosing when verified details match multiple active reservations', async () => {
      h.state.bookings.push({ ...h.state.bookings.find((booking) => booking.id === 90), id: 92 });
      originalBookings = await h.snapshot();
      await startRecovery();
      const response = await send('0801111111');
      expect(response.body.data.modify_step).toBe('awaiting_selection');
      expect(response.body.data.edit_booking_id).toBeUndefined();
      expect(response.body.data.reservation_options).toHaveLength(2);
      expect(response.body.message).toMatch(/which (?:one|.*reservation)/i);
      expectNoBookingChanges();
    });

    it('accepts an ISO date correction during verification without interpreting it as a phone number', async () => {
      await send('I want to alter my meeting reservation on 12-10-2026 under the name Steward');
      expectUnverified(await send('2026-10-14'));
      expect(query.mock.calls.filter(([sql]) => normalizeSql(sql).includes('regexp_replace'))).toEqual([]);
      expectRecovered(await send('0801111111'));
      expectNoBookingChanges();
    });

    it('does not parse a labelled date-shaped original phone as a lookup date correction', async () => {
      h.state.bookings.find((booking) => booking.id === 90).contact_phone = '2026-10-12';
      originalBookings = await h.snapshot();
      await startRecovery();
      expectRecovered(await send('The phone number is 2026-10-12'));
      expectNoBookingChanges();
    });

    it('updates the verified selected booking while preserving its original session and the newer current-session reservation', async () => {
      await startRecovery();
      expectRecovered(await send('0801111111'));
      const response = await send('Change the date to 15-10-2026 and the guests to eight');
      expect(response.body.data.date).toBe('15-10-2026');
      expect(response.body.data.people).toBe(8);
      expect(response.body.data.session_id).toBeUndefined();
      expect(h.state.bookings.find((booking) => booking.id === 90)).toEqual(expect.objectContaining({
        date: '2026-10-15', people: 8, status: 'modified', session_id: `sess-original-${fixtureNumber}`,
      }));
      expect(h.state.bookings.find((booking) => booking.id === 91)).toEqual(originalBookings.find((booking) => booking.id === 91));
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 90, date: '2026-10-15', people: 8 }));
    });

    it('cancels the recovered selection rather than the newest booking from the current conversation', async () => {
      expectUnverified(await startRecovery('cancel'));
      const verified = await send('0801111111');
      expect(verified.body.intent).toBe('cancel_booking');
      expect(verified.body.show_cancel_confirm).toBe(true);
      expect(verified.body.data.edit_booking_id).toBe(90);
      expect(verified.body.data.session_id).toBeUndefined();
      expectNoBookingChanges();

      const response = await h.request().post('/api/chat/confirm')
        .set('X-Session-Token', verified.body.session_token)
        .send({ session_id: sessionId, action: 'cancel' });
      expect(response.status).toBe(200);
      expect(response.body.booking_id).toBe(90);
      expect(h.state.bookings.find((booking) => booking.id === 90).status).toBe('cancelled');
      expect(h.state.bookings.find((booking) => booking.id === 91)).toEqual(originalBookings.find((booking) => booking.id === 91));
    });

    it('uses the recovered selection for "cancel my meeting" and revokes edit access once cancelled', async () => {
      await startRecovery();
      await send('0801111111');
      const selected = await send('Cancel my meeting');
      expect(selected.body.intent).toBe('cancel_booking');
      expect(selected.body.show_cancel_confirm).toBe(true);
      expect(selected.body.data.edit_booking_id).toBe(90);
      expect(selected.body.missing_fields).toEqual([]);
      const cancelled = await h.request().post('/api/chat/confirm')
        .set('X-Session-Token', selected.body.session_token)
        .send({ session_id: sessionId, action: 'cancel' });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.booking_id).toBe(90);
      mockUpsertEvent.mockClear();
      originalBookings = await h.snapshot();
      const laterEdit = await send('Change the guests to eight');
      expect(laterEdit.body.data.edit_booking_id).toBeUndefined();
      expect(h.state.bookings).toEqual(originalBookings);
      expect(mockUpsertEvent).not.toHaveBeenCalled();
    });

    it('does not edit or resync a selected reservation that has since been cancelled', async () => {
      await startRecovery();
      await send('0801111111');
      h.state.bookings.find((booking) => booking.id === 90).status = 'cancelled';
      originalBookings = await h.snapshot();
      const response = await send('Change the guests to eight');
      expect(response.body.message).not.toContain("updated your meeting reservation");
      expect(h.state.bookings).toEqual(originalBookings);
      expect(mockUpsertEvent).not.toHaveBeenCalled();
    });

    it('does not cancel a different current-session booking while the requested reservation is still unverified', async () => {
      const pending = await startRecovery('cancel');
      const response = await h.request().post('/api/chat/confirm')
        .set('X-Session-Token', pending.body.session_token)
        .send({ session_id: sessionId, action: 'cancel' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expectNoBookingChanges();
    });

    it('confirms the modified recovered selection rather than the latest current-session reservation', async () => {
      await startRecovery();
      await send('0801111111');
      const updated = await send('Change the guests to eight');
      expect(h.state.bookings.find((booking) => booking.id === 90).status).toBe('modified');
      mockUpsertEvent.mockClear();
      const response = await h.request().post('/api/chat/confirm')
        .set('X-Session-Token', updated.body.session_token)
        .send({ session_id: sessionId, action: 'confirm' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.booking_id).toBe(90);
      // Re-confirming a reservation that is already committed does not rewrite it.
      expect(h.state.bookings.find((booking) => booking.id === 90).status).toBe('modified');
      expect(h.state.bookings.find((booking) => booking.id === 91)).toEqual(originalBookings.find((booking) => booking.id === 91));
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 90, people: 8 }));
    });

    it('does not fall back to another booking if the recovered selection is no longer active', async () => {
      await startRecovery();
      const verified = await send('0801111111');
      h.state.bookings.find((booking) => booking.id === 90).status = 'cancelled';
      originalBookings = await h.snapshot();
      const response = await h.request().post('/api/chat/confirm')
        .set('X-Session-Token', verified.body.session_token)
        .send({ session_id: sessionId, action: 'cancel' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expectNoBookingChanges();
    });

    it('rejects a submitted booking ID that differs from the server-verified selection', async () => {
      await startRecovery();
      const verified = await send('0801111111');
      const response = await h.request().post('/api/chat/confirm')
        .set('X-Session-Token', verified.body.session_token)
        .send({ session_id: sessionId, booking_id: 91, action: 'cancel' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expectNoBookingChanges();
    });

    it('does not cancel the latest current-session booking when a recovered selection was lost during reset', async () => {
      await startRecovery();
      const verified = await send('0801111111');
      const reset = await h.request().post('/api/chat/reset')
        .set('X-Session-Token', verified.body.session_token)
        .send({ session_id: sessionId });
      expect(reset.status).toBe(200);
      const response = await h.request().post('/api/chat/confirm')
        .set('X-Session-Token', verified.body.session_token)
        .send({ session_id: sessionId, booking_id: 90, action: 'cancel' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expectNoBookingChanges();
    });

    it.each(['modify_booking', 'cancel_booking'])('applies phone verification to a model-inferred %s too', async (intent) => {
      mockChat.mockResolvedValue({
        ...defaultChatResponse,
        intent,
        data: { service_type: 'meeting', date: '14-10-2026', reservation_name: 'Steward' },
      });
      const response = await send('Please handle that request');
      expectUnverified(response);
      expect(mockChat).toHaveBeenCalledTimes(1);
      expectNoBookingChanges();
      const verified = await send('0801111111');
      expect(verified.body.data.edit_booking_id).toBe(90);
      expect(verified.body.data.session_id).toBeUndefined();
      if (intent === 'cancel_booking') expect(verified.body.show_cancel_confirm).toBe(true);
      else expectRecovered(verified);
      expect(mockChat).toHaveBeenCalledTimes(1);
    });

    it('requires a matching signed session token before clearing stored conversations', async () => {
      h.state.conversations.push({ session_id: sessionId, role: 'user', content: 'Keep until authorized' });
      const noToken = await h.request().post('/api/chat/reset').send({ session_id: sessionId });
      const anotherSessionToken = await h.request().post('/api/chat/reset')
        .set('X-Session-Token', h.sessionToken('another-session'))
        .send({ session_id: sessionId });
      expect(noToken.status).toBe(401);
      expect(anotherSessionToken.status).toBe(401);
      expect(h.state.conversations).toHaveLength(1);
      expectNoBookingChanges();
    });

    it('returns the signed session token after the first chat fails so that conversation reset still works', async () => {
      mockChat.mockRejectedValueOnce(new Error('Upstream model unavailable'));
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const failed = await h.request().post('/api/chat').send({ session_id: sessionId, message: 'Hello there' });
        expect(failed.status).toBe(500);
        expect(failed.body.session_token).toBe(h.sessionToken(sessionId));
        const reset = await h.request().post('/api/chat/reset')
          .set('X-Session-Token', failed.body.session_token)
          .send({ session_id: sessionId });
        expect(reset.status).toBe(200);
        expect(reset.body.success).toBe(true);
        expectNoBookingChanges();
      } finally {
        errorLog.mockRestore();
      }
    });

    it('clears only the signed session conversation and edit grant while preserving reservations', async () => {
      await startRecovery();
      const verified = await send('0801111111');
      h.state.conversations.push({ session_id: 'different-conversation', role: 'user', content: 'Keep this' });
      const response = await h.request().post('/api/chat/reset')
        .set('X-Session-Token', verified.body.session_token)
        .send({ session_id: sessionId });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(h.state.conversations).toEqual([{ session_id: 'different-conversation', role: 'user', content: 'Keep this' }]);
      expectNoBookingChanges();
      expectUnverified(await startRecovery());
      expectNoBookingChanges();
    });
  });

  describe('guided reservation alterations', () => {
    let fixtureNumber = 0;
    let sessionId;
    let originalBookings;
    const originalTimezone = process.env.CALENDAR_TIMEZONE;

    beforeEach(async () => {
      process.env.CALENDAR_TIMEZONE = 'Asia/Bangkok';
      jest.useFakeTimers({
        now: new Date('2026-10-05T08:00:00Z'),
        doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'hrtime', 'performance', 'queueMicrotask'],
      });
      sessionId = `sess-guided-alteration-${++fixtureNumber}`;
      h.state.inventory.push({ id: 1, category: 'meeting', code: 'M1', name: 'Boardroom', capacity: 20, quantity: 1, metadata: {} });
      h.state.bookings.push({
        id: 200,
        session_id: sessionId,
        service_type: 'meeting',
        date: '2026-10-14',
        start_time: '09:00:00',
        end_time: '10:00:00',
        reservation_name: 'Steward',
        people: 7,
        meeting_room_id: 1001,
        notes: 'Keep this original note',
        status: 'confirmed',
        waitlisted: false,
        contact_phone: '0801111111',
        contact_email: 'steward@example.com',
        google_event_id: 'guided-meeting-event',
        created_at: new Date('2026-10-01T00:00:00Z'),
        updated_at: new Date('2026-10-01T00:00:00Z'),
      });
      originalBookings = await h.snapshot();
      query.mockClear();
      mockUpsertEvent.mockResolvedValue('guided-meeting-event');
      mockChat.mockResolvedValue({
        ...defaultChatResponse,
        intent: 'book_restaurant',
        data: { service_type: 'restaurant', date: '12-10-2026', reservation_name: 'Stuart', people: 99 },
      });
    });

    afterEach(() => {
      jest.useRealTimers();
      if (originalTimezone === undefined) delete process.env.CALENDAR_TIMEZONE;
      else process.env.CALENDAR_TIMEZONE = originalTimezone;
    });

    async function send(message) {
      const response = await h.request().post('/api/chat').send({ session_id: sessionId, message });
      expect(response.status).toBe(200);
      return response;
    }

    function expectNoBookingChanges() {
      expect(h.state.bookings).toEqual(originalBookings);
      expect(mockUpsertEvent).not.toHaveBeenCalled();
      expect(query.mock.calls.filter(([sql]) =>
        /^(?:insert into|update|delete from) bookings\b/.test(normalizeSql(sql))
      )).toEqual([]);
    }

    async function chooseUniqueReservation() {
      const opening = await send('I would like to alter a booking');
      expect(opening.body.missing_fields).toEqual(['type of reservation', 'reservation name']);
      expect(opening.body.message).not.toMatch(/need[^.]*date/i);
      expect(opening.body.data.modify_step).toBe('awaiting_lookup');
      expectNoBookingChanges();

      const found = await send('The reservation type is meeting and the name is Steward');
      expect(found.body.data).toEqual(expect.objectContaining({
        edit_booking_id: 200, service_type: 'meeting', reservation_name: 'Steward',
        date: '14-10-2026', modify_step: 'choose_field', people: 7,
      }));
      expect(found.body.message).toMatch(/what would you like to (?:change|alter)/i);
      expectNoBookingChanges();
      return found;
    }

    async function addSecondReservation() {
      h.state.bookings.push({
        ...h.state.bookings.find((booking) => booking.id === 200),
        id: 201, date: '2026-10-21', start_time: '14:00:00', end_time: '15:00:00',
        google_event_id: 'second-guided-event', created_at: new Date('2026-10-02T00:00:00Z'),
      });
      originalBookings = await h.snapshot();
    }

    async function offerReservationChoices() {
      await send('alter a booking');
      const response = await send('Meeting, the name is Steward');
      expect(response.body.data.modify_step).toBe('awaiting_selection');
      expect(response.body.data.edit_booking_id).toBeUndefined();
      expect(response.body.data.reservation_options).toHaveLength(2);
      expect(response.body.message).toMatch(/which (?:one|.*reservation)/i);
      expect(JSON.stringify(response.body.data.reservation_options)).not.toMatch(/0801111111|steward@example\.com|guided-meeting-event|sess-guided/);
      expectNoBookingChanges();
      return response;
    }

    it('completes the type/name-only alteration scenario and politely ends after No, Thank you', async () => {
      await chooseUniqueReservation();
      const updated = await send('Change the date to October 16 this year and the guests to eight');
      expect(updated.body.intent).toBe('modify_booking');
      expect(updated.body.message).toContain('updated your meeting reservation');
      expect(updated.body.message).toMatch(/anything else/i);
      expect(h.state.bookings.find((booking) => booking.id === 200)).toEqual(expect.objectContaining({
        date: '2026-10-16', start_time: '09:00:00', end_time: '10:00:00',
        people: 8, reservation_name: 'Steward', service_type: 'meeting',
        notes: 'Keep this original note', contact_phone: '0801111111', status: 'modified',
      }));
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 200, date: '2026-10-16', people: 8 }));

      originalBookings = await h.snapshot();
      query.mockClear();
      mockUpsertEvent.mockClear();
      const goodbye = await send('No, Thank you');
      expect(goodbye.body.intent).toBe('farewell');
      expect(goodbye.body.message).toBe('Very well then, have a nice day.');
      expect(goodbye.body.data).toBeNull();
      expectNoBookingChanges();
      expect(mockChat).not.toHaveBeenCalled();

      const reopened = await send('I would like to alter a booking');
      expect(reopened.body.missing_fields).toEqual(['type of reservation', 'reservation name']);
      expect(reopened.body.data.edit_booking_id).toBeUndefined();
      expect(reopened.body.data.modify_step).toBe('awaiting_lookup');
      expectNoBookingChanges();
    });

    it.each(['Actually, change the guests to nine', 'Thank you, change the guests to nine', 'No, thank you, but change the guests to nine'])(
      'keeps the selected reservation available for a further edit: "%s"',
      async (continuation) => {
        await chooseUniqueReservation();
        await send('Change the guests to eight');
        const response = await send(continuation);
        expect(response.body.intent).toBe('modify_booking');
        expect(response.body.data.edit_booking_id).toBe(200);
        expect(response.body.message).toMatch(/anything else/i);
        expect(h.state.bookings.find((booking) => booking.id === 200).people).toBe(9);
        expect(h.state.bookings.find((booking) => booking.id === 200).date).toBe('2026-10-14');
        expect(mockChat).not.toHaveBeenCalled();
      }
    );

    it('reads the labelled 6pm time from a compound date/time amendment and preserves the one-hour duration', async () => {
      await chooseUniqueReservation();
      const response = await send('Change the date to 15-10-2026 and time to 6pm');
      expect(response.body.data.edit_booking_id).toBe(200);
      expect(response.body.data.date).toBe('15-10-2026');
      expect(response.body.data.start_time).toMatch(/^18:00(?::00)?$/);
      expect(response.body.data.end_time).toMatch(/^19:00(?::00)?$/);
      expect(h.state.bookings.find((booking) => booking.id === 200)).toEqual(expect.objectContaining({
        date: '2026-10-15', reservation_name: 'Steward', people: 7,
      }));
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({
        id: 200, date: '2026-10-15', start_time: expect.stringMatching(/^18:00(?::00)?$/),
        end_time: expect.stringMatching(/^19:00(?::00)?$/),
      }));
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('changes an explicitly labelled end time without altering the start time', async () => {
      await chooseUniqueReservation();
      const response = await send('Change the end time to 11am');
      expect(response.body.data.start_time).toMatch(/^09:00(?::00)?$/);
      expect(response.body.data.end_time).toMatch(/^11:00(?::00)?$/);
      expect(response.body.data.date).toBe('14-10-2026');
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({
        id: 200, start_time: expect.stringMatching(/^09:00(?::00)?$/),
        end_time: expect.stringMatching(/^11:00(?::00)?$/),
      }));
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('applies both ends of an explicit spoken meeting time range', async () => {
      await chooseUniqueReservation();
      const response = await send('Change the time from 9am to 11am');
      expect(response.body.data.start_time).toMatch(/^09:00(?::00)?$/);
      expect(response.body.data.end_time).toMatch(/^11:00(?::00)?$/);
      expect(response.body.data.date).toBe('14-10-2026');
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({
        id: 200, start_time: expect.stringMatching(/^09:00(?::00)?$/),
        end_time: expect.stringMatching(/^11:00(?::00)?$/),
      }));
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('accepts second one from multiple reservations and alters only that selected record', async () => {
      await addSecondReservation();
      const choices = await offerReservationChoices();
      const selectedId = choices.body.data.reservation_options[1].id;
      const selected = await send('the second one');
      expect(selected.body.data.edit_booking_id).toBe(selectedId);
      expect(selected.body.data.modify_step).toBe('choose_field');
      expectNoBookingChanges();
      const response = await send('Change the guests to eight');
      expect(response.body.data.edit_booking_id).toBe(selectedId);
      expect(h.state.bookings.find((booking) => booking.id === selectedId).people).toBe(8);
      const untouchedId = selectedId === 200 ? 201 : 200;
      expect(h.state.bookings.find((booking) => booking.id === untouchedId)).toEqual(originalBookings.find((booking) => booking.id === untouchedId));
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('interprets reservation #2 as the authorized reservation ID even when it is the first option', async () => {
      const originalMeeting = h.state.bookings.find((booking) => booking.id === 200);
      h.state.bookings = h.state.bookings.filter((booking) => ![2, 200].includes(booking.id));
      h.state.bookings.push({
        ...originalMeeting, id: 201, date: '2026-10-21', start_time: '14:00:00', end_time: '15:00:00',
        google_event_id: 'second-guided-event',
      }, { ...originalMeeting, id: 2 });
      originalBookings = await h.snapshot();
      const choices = await offerReservationChoices();
      expect(choices.body.data.reservation_options.map((option) => option.id)).toEqual([2, 201]);
      const selected = await send('reservation #2');
      expect(selected.body.data.edit_booking_id).toBe(2);
      expectNoBookingChanges();
      const updated = await send('Change the guests to eight');
      expect(updated.body.data.edit_booking_id).toBe(2);
      expect(h.state.bookings.find((booking) => booking.id === 2).people).toBe(8);
      expect(h.state.bookings.find((booking) => booking.id === 201)).toEqual(originalBookings.find((booking) => booking.id === 201));
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('rejects a reservation ID outside the offered authorized choices without selecting or changing a record', async () => {
      await addSecondReservation();
      await offerReservationChoices();
      const response = await send('reservation #999');
      expect(response.body.data.modify_step).toBe('awaiting_selection');
      expect(response.body.data.edit_booking_id).toBeUndefined();
      expect(response.body.data.reservation_options).toHaveLength(2);
      expectNoBookingChanges();
      expect(mockChat).not.toHaveBeenCalled();
    });

    it.each(['October 14', 'the one at 9am'])(
      'selects the correct reservation using plain English: "%s"',
      async (selection) => {
        await addSecondReservation();
        await offerReservationChoices();
        const selected = await send(selection);
        expect(selected.body.data.edit_booking_id).toBe(200);
        expect(selected.body.data.date).toBe('14-10-2026');
        expect(selected.body.data.modify_step).toBe('choose_field');
        expectNoBookingChanges();
        expect(mockChat).not.toHaveBeenCalled();
      }
    );

    it('uses a volunteered date to narrow the type/name search to one reservation', async () => {
      await addSecondReservation();
      const found = await send('I want to alter my meeting reservation on 21-10-2026 under the name Steward');
      expect(found.body.data.edit_booking_id).toBe(201);
      expect(found.body.data.date).toBe('21-10-2026');
      expect(found.body.data.modify_step).toBe('choose_field');
      expectNoBookingChanges();
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('leaves the selected reservation untouched when its meeting room is occupied at the requested date and time', async () => {
      h.state.bookings.push({
        ...h.state.bookings.find((booking) => booking.id === 200),
        id: 202, session_id: 'another-meeting-customer', reservation_name: 'Other guest',
        date: '2026-10-16', google_event_id: 'occupied-room-event',
      });
      originalBookings = await h.snapshot();
      await chooseUniqueReservation();
      const response = await send('Change the date to October 16 this year');
      expect(response.body.message).toMatch(/unavailable|no availability/i);
      expect(response.body.message).not.toContain('updated your meeting reservation');
      expectNoBookingChanges();
      expect(mockChat).not.toHaveBeenCalled();
    });

    it.each(['Change the name to May', 'May'])('changes the name with "%s" without treating it as a new date', async (message) => {
      await chooseUniqueReservation();
      if (message === 'May') await send('name');
      const response = await send(message);
      expect(response.body.data.reservation_name).toBe('May');
      expect(response.body.data.date).toBe('14-10-2026');
      expect(response.body.data.start_time).toMatch(/^09:00(?::00)?$/);
      expect(response.body.data.end_time).toMatch(/^10:00(?::00)?$/);
      expect(h.state.bookings.find((booking) => booking.id === 200)).toEqual(expect.objectContaining({
        reservation_name: 'May', date: '2026-10-14', start_time: '09:00:00', end_time: '10:00:00', people: 7,
      }));
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({
        id: 200, reservation_name: 'May', date: '2026-10-14', start_time: '09:00:00', end_time: '10:00:00',
      }));
      expect(mockChat).not.toHaveBeenCalled();
    });

    it.each(['Change the notes to arriving on Friday at 6pm', 'arriving on Friday at 6pm'])(
      'keeps the weekday and time in notes "%s" without rescheduling',
      async (message) => {
        await chooseUniqueReservation();
        if (message === 'arriving on Friday at 6pm') await send('notes');
        const response = await send(message);
        expect(response.body.data.notes).toBe('arriving on Friday at 6pm');
        expect(response.body.data.date).toBe('14-10-2026');
        expect(response.body.data.start_time).toMatch(/^09:00(?::00)?$/);
        expect(response.body.data.end_time).toMatch(/^10:00(?::00)?$/);
        expect(h.state.bookings.find((booking) => booking.id === 200)).toEqual(expect.objectContaining({
          notes: 'arriving on Friday at 6pm', date: '2026-10-14', start_time: '09:00:00', end_time: '10:00:00', people: 7,
        }));
        expect(mockChat).not.toHaveBeenCalled();
      }
    );

    it('separates a labelled guest amendment from notes containing a weekday without changing the schedule', async () => {
      await chooseUniqueReservation();
      const response = await send('Change the notes to arriving Friday and change the guests to eight');
      expect(response.body.data.notes).toBe('arriving Friday');
      expect(response.body.data.people).toBe(8);
      expect(response.body.data.date).toBe('14-10-2026');
      expect(response.body.data.start_time).toMatch(/^09:00(?::00)?$/);
      expect(response.body.data.end_time).toMatch(/^10:00(?::00)?$/);
      expect(h.state.bookings.find((booking) => booking.id === 200)).toEqual(expect.objectContaining({
        notes: 'arriving Friday', people: 8, date: '2026-10-14', start_time: '09:00:00', end_time: '10:00:00',
      }));
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({
        id: 200, notes: 'arriving Friday', people: 8, date: '2026-10-14', start_time: '09:00:00', end_time: '10:00:00',
      }));
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('requires a unique reservation choice before applying an alteration', async () => {
      await addSecondReservation();
      await offerReservationChoices();
      const response = await send('Change the guests to eight');
      expect(response.body.data.modify_step).toBe('awaiting_selection');
      expect(response.body.data.edit_booking_id).toBeUndefined();
      expect(response.body.message).toMatch(/which (?:one|.*reservation)/i);
      expectNoBookingChanges();
    });

    it('does not cancel an unrelated reservation while waiting for a selection', async () => {
      await addSecondReservation();
      const choices = await offerReservationChoices();
      const response = await h.request().post('/api/chat/confirm')
        .set('X-Session-Token', choices.body.session_token)
        .send({ session_id: sessionId, action: 'cancel' });
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expectNoBookingChanges();
    });

    it('recovers reservations across conversations without requiring a date when type, name and original phone match', async () => {
      h.state.bookings.find((booking) => booking.id === 200).session_id = 'previous-guided-conversation';
      originalBookings = await h.snapshot();
      await send('alter a booking');
      const pending = await send('Meeting, the name is Steward');
      expect(pending.body.data.modify_step).toBe('awaiting_verification');
      expect(pending.body.missing_fields).toEqual(['phone number']);
      expectNoBookingChanges();
      const found = await send('0801111111');
      expect(found.body.data.edit_booking_id).toBe(200);
      expect(found.body.data.date).toBe('14-10-2026');
      expect(found.body.data.modify_step).toBe('choose_field');
      expectNoBookingChanges();
      expect(mockChat).not.toHaveBeenCalled();
    });
  });

  describe('new booking reservation types', () => {
    let fixtureNumber = 0;
    let sessionId;
    let originalBookings;

    beforeEach(async () => {
      h.seedAlterationInventory();
      sessionId = `sess-new-service-${++fixtureNumber}`;
      originalBookings = await h.snapshot();
      query.mockClear();
      mockChat.mockResolvedValue({
        ...defaultChatResponse,
        intent: 'book_restaurant',
        data: {
          service_type: 'restaurant', date: '14-10-2026', reservation_name: 'Kai',
          start_time: '', end_time: '', people: null, phone_number: '',
        },
      });
    });

    async function send(message) {
      const response = await h.request().post('/api/chat').send({ session_id: sessionId, message });
      expect(response.status).toBe(200);
      return response;
    }

    function expectNoBookingChanges() {
      expect(h.state.bookings).toEqual(originalBookings);
      expect(mockUpsertEvent).not.toHaveBeenCalled();
      expect(query.mock.calls.filter(([sql]) =>
        /^(?:insert into|update|delete from) bookings\b/.test(normalizeSql(sql))
      )).toEqual([]);
    }

    it('keeps an explicit new meeting-room request as a meeting when the model incorrectly chooses restaurant', async () => {
      const response = await send('Book a meeting room on 14-10-2026 under the name Kai');
      expect(response.body.intent).toBe('book_meeting');
      expect(response.body.data).toEqual(expect.objectContaining({
        service_type: 'meeting', date: '14-10-2026', reservation_name: 'Kai',
      }));
      expect(response.body.missing_fields).toContain('start_time');
      expectNoBookingChanges();
    });

    it('asks for a reservation type before saving a new request with conflicting types', async () => {
      const response = await send('Book hotel or restaurant on 14-10-2026 under the name Kai');
      expect(response.body.missing_fields).toEqual(['type of reservation']);
      expect(response.body.data).toEqual(expect.objectContaining({
        service_type: '', booking_step: 'awaiting_service', service_candidates: ['hotel', 'restaurant'],
        date: '14-10-2026', reservation_name: 'Kai',
      }));
      expectNoBookingChanges();
    });

    it('accepts a bare meeting clarification without losing the saved new-booking date and name', async () => {
      await send('Book hotel or restaurant on 14-10-2026 under the name Kai');
      mockChat.mockResolvedValue({
        ...defaultChatResponse,
        intent: 'book_restaurant',
        data: { service_type: 'restaurant', date: '12-10-2026', reservation_name: 'Stuart' },
      });
      const response = await send('meeting');
      expect(response.body.intent).toBe('book_meeting');
      expect(response.body.data).toEqual(expect.objectContaining({
        service_type: 'meeting', date: '14-10-2026', reservation_name: 'Kai',
      }));
      expect(response.body.data.booking_step).not.toBe('awaiting_service');
      expectNoBookingChanges();
    });
  });

  describe('plain-English booking changes', () => {
    let fixtureNumber = 0;
    let sessionId;
    const originalTimezone = process.env.CALENDAR_TIMEZONE;

    beforeEach(async () => {
      h.seedAlterationInventory();
      process.env.CALENDAR_TIMEZONE = 'Asia/Bangkok';
      jest.useFakeTimers({
        now: new Date('2026-10-04T18:30:00Z'),
        doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'hrtime', 'performance', 'queueMicrotask'],
      });
      sessionId = `sess-natural-modify-${++fixtureNumber}`;
      h.state.bookings.push({
        id: 50,
        session_id: sessionId,
        service_type: 'hotel',
        date: '2026-10-05',
        end_date: '2026-10-08',
        start_time: '14:00:00',
        end_time: '11:00:00',
        reservation_name: 'Brett',
        people: 4,
        notes: '',
        status: 'confirmed',
        waitlisted: false,
        contact_phone: '0801111111',
        google_event_id: 'existing-calendar-event',
        created_at: new Date(),
        updated_at: new Date(),
      });
      mockUpsertEvent.mockResolvedValue('existing-calendar-event');
    });

    afterEach(() => {
      jest.useRealTimers();
      if (originalTimezone === undefined) delete process.env.CALENDAR_TIMEZONE;
      else process.env.CALENDAR_TIMEZONE = originalTimezone;
    });

    async function openReservationSlip() {
      const response = await h.request().post('/api/chat').send({
        session_id: sessionId, message: 'show me the reservation slip',
      });
      expect(response.status).toBe(200);
      expect(response.body.show_reservation_slip).toBe(true);
      expect(response.body.data.phone_number).toBe('0801111111');
    }

    async function change(message) {
      return h.request().post('/api/chat').send({ session_id: sessionId, message });
    }

    it('applies date, spoken guest count and phone from one choose-field message', async () => {
      await openReservationSlip();
      const response = await change('Change my booking to day after tomorrow, not tomorrow, for five guests, phone number is 0807777777');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '07-10-2026', end_date: '10-10-2026', people: 5,
        contact_phone: '0807777777', phone_number: '0807777777', status: 'modified',
        calendar_sync: { status: 'synced' },
      }));
      expect(response.body.message).toContain('5 guests');
      expect(response.body.message).toContain('Google Calendar has been updated');
      expect(mockChat).not.toHaveBeenCalled();
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({
        date: '2026-10-07', end_date: '2026-10-10', people: 5, contact_phone: '0807777777',
      }));
      expect(h.state.bookings.find((item) => item.id === 50).date).toBe('2026-10-07');
    });

    it('accepts a written ordinal date after the ordinary date prompt', async () => {
      await openReservationSlip();
      expect((await change('date')).body.message).toContain('What date would you like instead?');
      const response = await change('seventh October this year');
      expect(response.body.data.date).toBe('07-10-2026');
      expect(response.body.data.end_date).toBe('10-10-2026');
    });

    it('applies the screenshot-shaped restaurant change without asking for values again', async () => {
      Object.assign(h.state.bookings.find((item) => item.id === 50), {
        service_type: 'restaurant', end_date: null, start_time: '18:00:00', end_time: '19:00:00',
      });
      await openReservationSlip();
      const response = await change("we'll come the day after tomorrow and. the guest is five change the phone number into 0807777777");
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '07-10-2026', people: 5, contact_phone: '0807777777', phone_number: '0807777777',
      }));
      expect(response.body.message).toContain('updated your restaurant reservation');
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({
        date: '2026-10-07', people: 5, contact_phone: '0807777777',
      }));
    });

    it('retains supplied guest and phone changes while an invalid date is corrected', async () => {
      await openReservationSlip();
      const invalid = await change('Change the date to 31-02-2026 for five guests, phone number 0807777777');
      expect(invalid.body.message).toContain('What date would you like instead?');
      expect(h.state.bookings.find((item) => item.id === 50).people).toBe(4);
      expect(mockUpsertEvent).not.toHaveBeenCalled();

      const response = await change('tomorrow');
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '06-10-2026', end_date: '09-10-2026', people: 5, phone_number: '0807777777',
      }));
    });

    it('honors an explicit new hotel checkout instead of preserving the old duration', async () => {
      await openReservationSlip();
      const response = await change('Change check-in to seventh October this year and check-out to twelfth October this year');
      expect(response.body.data.date).toBe('07-10-2026');
      expect(response.body.data.end_date).toBe('12-10-2026');
    });

    it('keeps the chosen arrival while correcting an invalid checkout', async () => {
      await openReservationSlip();
      const invalid = await change('Change check-in to seventh October this year and check-out to sixth October this year');
      expect(invalid.body.message).toContain('check-out date must be after');
      const response = await change('twelfth October this year');
      expect(response.body.data.date).toBe('07-10-2026');
      expect(response.body.data.end_date).toBe('12-10-2026');
    });

    it('keeps numeric date/time edits working and accepts a bare phone after its prompt', async () => {
      await openReservationSlip();
      const dated = await change('Change date to 09-10-2026 and time to 09:30');
      expect(dated.body.data.date).toBe('09-10-2026');
      // Hotel check-in time is property policy; the requested arrival is kept as a note.
      expect(dated.body.data.start_time).toMatch(/^14:00(?::00)?$/);
      expect(dated.body.data.notes).toContain('Requested arrival time 09:30');
      expect(dated.body.message).toContain('Check-in is from 14:00');
      expect((await change('phone number')).body.message).toContain('What phone number');
      const response = await change('0808888888');
      expect(response.body.data.phone_number).toBe('0808888888');
    });

    it('reports saved booking changes when Calendar returns no event', async () => {
      await openReservationSlip();
      mockUpsertEvent.mockResolvedValue(null);
      const response = await change('Move the date to tomorrow');
      expect(response.body.data.date).toBe('06-10-2026');
      expect(response.body.data.calendar_sync).toEqual({ status: 'failed' });
      expect(response.body.message).toContain('Google Calendar could not be updated');
      expect(response.body.message).not.toContain('Google Calendar has been updated');
    });

    it.each(['confirmed', 'modified'])('updates an existing Calendar event when a legacy %s reservation retains its waitlist flag', async (status) => {
      Object.assign(h.state.bookings.find((booking) => booking.id === 50), { status, waitlisted: true });
      await openReservationSlip();

      const response = await change('Move the date to tomorrow');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '06-10-2026', waitlisted: true, status: 'modified', calendar_sync: { status: 'synced' },
      }));
      expect(response.body.message).toContain('Google Calendar has been updated');
      expect(response.body.message).not.toContain('remains on the waitlist');
      expect(mockUpsertEvent).toHaveBeenCalledWith(expect.objectContaining({
        id: 50, date: '2026-10-06', google_event_id: 'existing-calendar-event', waitlisted: true,
      }));
    });

    it('saves a genuine waitlist change without creating a Calendar event or claiming a sync', async () => {
      Object.assign(h.state.bookings.find((booking) => booking.id === 50), {
        status: 'pending', waitlisted: true, google_event_id: null,
      });
      await openReservationSlip();

      const response = await change('Move the date to tomorrow');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(expect.objectContaining({
        date: '06-10-2026', waitlisted: true, status: 'pending', calendar_sync: { status: 'not_required' },
      }));
      expect(response.body.message).toContain('remains on the waitlist');
      expect(response.body.message).not.toContain('Google Calendar has been updated');
      expect(mockUpsertEvent).not.toHaveBeenCalled();
      expect(h.state.bookings.find((booking) => booking.id === 50).google_event_id).toBeNull();
    });

    it('reports disabled Calendar sync without attempting an API call', async () => {
      await openReservationSlip();
      mockCalendarEnabled.mockReturnValue(false);
      const response = await change('five guests');
      expect(response.body.data.people).toBe(5);
      expect(response.body.data.calendar_sync).toEqual({ status: 'disabled' });
      expect(response.body.message).toContain('sync is disabled');
      expect(mockUpsertEvent).not.toHaveBeenCalled();
    });

    it('keeps the booking edit saved if the Calendar operation throws', async () => {
      await openReservationSlip();
      mockUpsertEvent.mockRejectedValue(new Error('Calendar unavailable'));
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const response = await change('Move the date to tomorrow');
        expect(response.status).toBe(200);
        expect(response.body.data.date).toBe('06-10-2026');
        expect(response.body.data.calendar_sync).toEqual({ status: 'failed' });
        expect(response.body.message).toContain('Google Calendar could not be updated');
      } finally {
        errorLog.mockRestore();
      }
    });
  });

  it('treats a fresh dinner request as a new booking instead of reusing old modify state', async () => {
    h.seedAlterationInventory();
    h.state.bookings.push({
      id: 4,
      session_id: 'sess-fresh',
      service_type: 'meeting',
      date: '2027-05-15',
      start_time: '10:00:00',
      end_time: '11:00:00',
      reservation_name: 'Steve',
      people: 3,
      location: 'Room 1',
      notes: '',
      status: 'confirmed',
      waitlisted: false,
      contact_email: 'steve@example.com',
      contact_phone: '0800777000',
      created_at: new Date('2027-05-01T00:00:00Z'),
      updated_at: new Date('2027-05-01T00:00:00Z'),
    });

    mockChat.mockResolvedValueOnce({
      message: 'Certainly, I can help with a new dinner reservation.',
      speak: 'Certainly, I can help with a new dinner reservation.',
      intent: 'book_restaurant',
      data: {
        service_type: 'restaurant',
        date: '12-04-2027',
        start_time: '',
        end_time: '',
        people: 3,
        location: '',
        notes: '',
        reservation_name: '',
        phone_number: '',
      },
      missing_fields: ['start_time', 'reservation_name', 'phone_number'],
      confidence: 1,
    });

    const res = await h.request()
      .post('/api/chat')
      .send({
        session_id: 'sess-fresh',
        message: 'Dinner for three tonight',
      });

    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('book_restaurant');
    expect(res.body.message).toContain('I need a bit more info');
    expect(res.body.message).not.toContain("couldn't find");
  });

  it('prefers the explicit booking date from the user message over the model guess', async () => {
    h.seedAlterationInventory();
    mockChat.mockResolvedValueOnce({
      message: 'Perfect, I have everything I need.',
      speak: 'Perfect, I have everything I need.',
      intent: 'book_restaurant',
      data: {
        service_type: 'restaurant',
        date: '17-04-2027',
        start_time: '21:00:00',
        end_time: '',
        people: 3,
        location: '',
        notes: '',
        reservation_name: 'Kay',
        phone_number: '0805658109',
      },
      missing_fields: [],
      confidence: 1,
    });

    const res = await h.request()
      .post('/api/chat')
      .send({
        session_id: 'sess-booking-date',
        message: 'Dinner for three on 18-05-2027 9pm. reservation name is Kay. phone number is 0805658109',
      });

    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('book_restaurant');
    expect(res.body.data.date).toBe('18-05-2027');
    // A conversational draft holds no inventory and writes no reservation.
    expect(h.state.bookings.find((item) => item.session_id === 'sess-booking-date')).toBeUndefined();
    expect(res.body.data.draft.request.date).toBe('2027-05-18');
    expect(res.body.requires_confirmation).toBe(true);

    const confirmed = await h.request().post('/api/chat/confirm')
      .set('X-Session-Id', 'sess-booking-date').set('X-Session-Token', res.body.session_token)
      .send({ session_id: 'sess-booking-date', action: 'confirm' });
    expect(confirmed.body.success).toBe(true);
    const created = h.state.bookings.find((item) => item.session_id === 'sess-booking-date');
    expect(created).toEqual(expect.objectContaining({ date: '2027-05-18', status: 'confirmed', start_time: '21:00:00' }));
  });

  it('shows a reserved booking slip when the user asks to view an existing booking', async () => {
    h.state.bookings.push({
      id: 5,
      session_id: 'sess-slip',
      service_type: 'restaurant',
      date: '2027-05-15',
      start_time: '19:00:00',
      end_time: '20:00:00',
      reservation_name: 'John',
      people: 3,
      location: 'Patio',
      notes: '',
      status: 'confirmed',
      waitlisted: false,
      contact_email: 'john@example.com',
      contact_phone: '0800568109',
      created_at: new Date('2027-04-10T00:00:00Z'),
      updated_at: new Date('2027-04-10T00:00:00Z'),
    });

    const res = await h.request()
      .post('/api/chat')
      .send({
        session_id: 'sess-slip',
        message: 'I want to see my already reserved booking on 15-05-2027 name John and type is dinner',
      });

    expect(res.status).toBe(200);
    expect(res.body.show_reservation_slip).toBe(true);
    expect(res.body.data.reservation_name).toBe('John');
    expect(res.body.data.people).toBe(3);
    expect(res.body.data.service_type).toBe('restaurant');
    expect(res.body.message).toContain('reservation slip');
  });

});
