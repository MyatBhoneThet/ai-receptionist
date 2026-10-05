import { jest } from '@jest/globals';

const events = {
  insert: jest.fn(), update: jest.fn(), delete: jest.fn(), get: jest.fn(),
};
const JWT = jest.fn();
const createCalendar = jest.fn();

await jest.unstable_mockModule('googleapis', () => ({
  google: { auth: { JWT }, calendar: createCalendar },
}));
// Tests must never load real credentials from the local .env file.
await jest.unstable_mockModule('dotenv/config', () => ({}));

const envKeys = ['GOOGLE_CALENDAR_ID', 'GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'CALENDAR_TIMEZONE'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const booking = {
  id: 42, service_type: 'restaurant', date: '07-10-2026',
  start_time: '16:00:00', end_time: '17:00:00', people: 5,
};

async function loadService() {
  jest.resetModules();
  return import('../services/googleCalendar.js');
}

function insertedEvent() {
  return events.insert.mock.calls[0][0].resource;
}

describe('Google Calendar booking sync', () => {
  beforeEach(() => {
    process.env.GOOGLE_CALENDAR_ID = 'test-calendar';
    process.env.GOOGLE_CLIENT_EMAIL = 'test@example.com';
    process.env.GOOGLE_PRIVATE_KEY = 'fake-test-key';
    process.env.CALENDAR_TIMEZONE = 'Asia/Bangkok';
    Object.values(events).forEach((mock) => mock.mockReset());
    events.insert.mockResolvedValue({ data: { id: 'new-event', htmlLink: 'https://example.com/event' } });
    events.update.mockResolvedValue({ data: { htmlLink: 'https://example.com/event' } });
    JWT.mockReset().mockImplementation(() => ({}));
    createCalendar.mockReset().mockReturnValue({ events });
    ['log', 'error', 'warn'].forEach((method) => jest.spyOn(console, method).mockImplementation(() => {}));
  });

  afterEach(() => {
    envKeys.forEach((key) => {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    });
    jest.restoreAllMocks();
  });

  it('interprets ambiguous DD-MM-YYYY dates as October, not July', async () => {
    const { upsertEvent } = await loadService();
    expect(await upsertEvent(booking)).toBe('new-event');
    expect(events.insert).toHaveBeenCalledWith(expect.objectContaining({ calendarId: 'test-calendar' }));
    expect(insertedEvent().start).toEqual({ dateTime: '2026-10-07T16:00:00', timeZone: 'Asia/Bangkok' });
    expect(insertedEvent().end.dateTime).toBe('2026-10-07T17:00:00');
  });

  it.each([
    ['ISO date', '2026-10-07'],
    ['SQL DATE at local midnight', new Date(2026, 9, 7)],
  ])('preserves the calendar day of a %s', async (_, date) => {
    const { upsertEvent } = await loadService();
    await upsertEvent({ ...booking, date });
    expect(insertedEvent().start.dateTime).toBe('2026-10-07T16:00:00');
  });

  it('keeps a hotel checkout on its separate end date', async () => {
    const { upsertEvent } = await loadService();
    await upsertEvent({ ...booking, service_type: 'hotel', end_date: '10-10-2026', start_time: '14:00', end_time: '11:00' });
    expect(insertedEvent().start.dateTime).toBe('2026-10-07T14:00:00');
    expect(insertedEvent().end.dateTime).toBe('2026-10-10T11:00:00');
  });

  it('advances an invalid same-day end by one wall-clock hour across midnight', async () => {
    const { upsertEvent } = await loadService();
    await upsertEvent({ ...booking, date: '31-10-2026', start_time: '23:30', end_time: '22:00' });
    expect(insertedEvent().start.dateTime).toBe('2026-10-31T23:30:00');
    expect(insertedEvent().end).toEqual({ dateTime: '2026-11-01T00:30:00', timeZone: 'Asia/Bangkok' });
  });

  it.each([
    { date: '31-02-2026' }, { date: '2026-13-07' }, { date: 'tomorrow' },
    { date: new Date(NaN) }, { end_date: '31-02-2026' }, { start_time: '24:00' },
    { start_time: '16:60' }, { end_time: '17:00:60' },
  ])('rejects invalid date/time fields without contacting Calendar: %j', async (invalidFields) => {
    const { upsertEvent } = await loadService();
    expect(await upsertEvent({ ...booking, ...invalidFields })).toBeNull();
    expect(events.insert).not.toHaveBeenCalled();
    expect(events.update).not.toHaveBeenCalled();
  });

  it('updates the existing event instead of inserting a duplicate', async () => {
    const { upsertEvent } = await loadService();
    expect(await upsertEvent({ ...booking, google_event_id: 'existing-event' })).toBe('existing-event');
    expect(events.update).toHaveBeenCalledWith(expect.objectContaining({
      calendarId: 'test-calendar', eventId: 'existing-event',
      resource: expect.objectContaining({ start: { dateTime: '2026-10-07T16:00:00', timeZone: 'Asia/Bangkok' } }),
    }));
    expect(events.insert).not.toHaveBeenCalled();
  });

  it.each([{ code: 404 }, { response: { status: 410 } }])('recreates an event removed from Calendar: %j', async (providerError) => {
    events.update.mockRejectedValue(Object.assign(new Error('Event removed'), providerError));
    const { upsertEvent } = await loadService();
    expect(await upsertEvent({ ...booking, google_event_id: 'removed-event' })).toBe('new-event');
    expect(events.update).toHaveBeenCalledTimes(1);
    expect(events.insert).toHaveBeenCalledTimes(1);
    expect(insertedEvent().start.dateTime).toBe('2026-10-07T16:00:00');
  });

  it('returns null when the provider rejects an update without creating a duplicate', async () => {
    events.update.mockRejectedValue(Object.assign(new Error('Provider unavailable'), { code: 503 }));
    const { upsertEvent } = await loadService();
    expect(await upsertEvent({ ...booking, google_event_id: 'existing-event' })).toBeNull();
    expect(events.insert).not.toHaveBeenCalled();
  });

  it.each([{ code: '404' }, { response: { status: 410 } }])('recognizes a missing event during status checks: %j', async (providerError) => {
    events.get.mockRejectedValue(Object.assign(new Error('Event removed'), providerError));
    const { getEventStatus } = await loadService();
    expect(await getEventStatus('removed-event')).toEqual({ available: false, reason: 'missing' });
  });

  it.each([{ code: '404' }, { response: { status: 410 } }])('treats an already removed event as successfully deleted: %j', async (providerError) => {
    events.delete.mockRejectedValue(Object.assign(new Error('Event removed'), providerError));
    const { cancelEvent } = await loadService();
    expect(await cancelEvent('removed-event')).toBe(true);
  });

  it.each(['GOOGLE_CALENDAR_ID', 'GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY'])('disables sync when %s is missing', async (key) => {
    delete process.env[key];
    const { isCalendarSyncEnabled, upsertEvent } = await loadService();
    expect(isCalendarSyncEnabled()).toBe(false);
    expect(await upsertEvent(booking)).toBeNull();
    expect(events.insert).not.toHaveBeenCalled();
    expect(events.update).not.toHaveBeenCalled();
  });

  it('normalizes singly and doubly escaped private-key newlines', async () => {
    process.env.GOOGLE_PRIVATE_KEY = String.raw`first\nsecond\\nthird`;
    const { isCalendarSyncEnabled } = await loadService();
    expect(isCalendarSyncEnabled()).toBe(true);
    expect(JWT).toHaveBeenCalledWith({
      email: 'test@example.com', key: 'first\nsecond\nthird',
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
  });
});
