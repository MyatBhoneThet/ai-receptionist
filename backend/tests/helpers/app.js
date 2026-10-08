// Boots the Express app for integration tests with ONLY the outside world
// mocked: the language model, Google Calendar, outbound notifications and rate
// limits. The database is real PostgreSQL.
import { jest } from '@jest/globals';

export const defaultChatResponse = {
  message: 'How can I help?', speak: 'How can I help?', intent: 'unknown',
  data: { service_type: '', date: '', start_time: '', end_time: '', end_date: '', people: null, notes: '',
    reservation_name: '', phone_number: '', email: '' },
  missing_fields: [], confidence: 0.5,
};

export async function loadApp({ spyDb = false } = {}) {
  const mockChat = jest.fn().mockResolvedValue(defaultChatResponse);
  const mockUpsertEvent = jest.fn().mockResolvedValue(null);
  const mockCancelEvent = jest.fn().mockResolvedValue(true);
  const mockGetEventStatus = jest.fn().mockResolvedValue({ available: true, reason: 'found' });
  const mockCalendarEnabled = jest.fn().mockReturnValue(false);
  const mockNotify = jest.fn().mockResolvedValue({});
  const calendarTargets = [];

  await jest.unstable_mockModule('../../services/llm.js', () => ({ chat: mockChat }));
  await jest.unstable_mockModule('../../services/googleCalendar.js', () => ({
    // The business's calendar target is recorded separately so assertions can
    // stay about the reservation that was sent.
    upsertEvent: (booking, target) => { calendarTargets.push(target); return mockUpsertEvent(booking); },
    cancelEvent: (eventId, target) => { calendarTargets.push(target); return mockCancelEvent(eventId); },
    getEventStatus: mockGetEventStatus,
    isCalendarSyncEnabled: mockCalendarEnabled,
  }));
  await jest.unstable_mockModule('../../services/notifications.js', () => ({
    notifyBooking: mockNotify, formatWebhookPayload: () => ({}), notificationsHealth: {},
  }));
  const pass = (_req, _res, next) => next();
  await jest.unstable_mockModule('../../middleware/rateLimiter.js', () => ({
    globalLimiter: pass, chatLimiter: pass, bookingsLimiter: pass, authLimiter: pass,
  }));

  // Optionally record every SQL statement the booking layer runs (including
  // those inside transactions) while still executing it for real.
  let dbSpy = null;
  if (spyDb) {
    const actual = await import('../../services/db.js');
    dbSpy = jest.fn((text, params) => actual.query(text, params));
    await jest.unstable_mockModule('../../services/db.js', () => ({
      default: actual.default,
      query: dbSpy,
      withTransaction: (fn) => actual.withTransaction((client) => fn({
        query: (text, params) => { dbSpy.mock.calls.push([text, params]); return client.query(text, params); },
      })),
    }));
  }

  const { default: app } = await import('../../index.js');
  const auth = await import('../../middleware/auth.js');
  const { signAccessToken } = await import('../../services/auth.js');
  return {
    app, dbSpy, calendarTargets, mockChat, mockUpsertEvent, mockCancelEvent, mockGetEventStatus, mockCalendarEnabled, mockNotify,
    createSessionToken: auth.createSessionToken,
    tokenFor: (user) => signAccessToken({ id: user.id, role: user.role || 'customer', email: user.email }),
    resetMocks() {
      mockChat.mockReset().mockResolvedValue(defaultChatResponse);
      mockUpsertEvent.mockReset().mockResolvedValue(null);
      mockCancelEvent.mockReset().mockResolvedValue(true);
      mockGetEventStatus.mockReset().mockResolvedValue({ available: true, reason: 'found' });
      mockCalendarEnabled.mockReset().mockReturnValue(false);
      mockNotify.mockReset().mockResolvedValue({});
      calendarTargets.length = 0;
    },
  };
}

/** A model reply that has extracted every field of a booking. */
export function llmBooking(intent, data) {
  return { ...defaultChatResponse, intent, message: 'Let me check that for you.', speak: 'Let me check that for you.',
    data: { ...defaultChatResponse.data, ...data }, confidence: 1 };
}
