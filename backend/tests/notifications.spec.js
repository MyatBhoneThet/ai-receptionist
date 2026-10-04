import { jest } from '@jest/globals';

describe('notifications', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, STAFF_WEBHOOK_URL: 'https://example.com/webhook' };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
    delete global.fetch;
  });

  it('formats a slack-compatible webhook payload', async () => {
    const { formatWebhookPayload } = await import('../services/notifications.js');
    const payload = formatWebhookPayload({
      type: 'confirm',
      isVip: false,
      booking: {
        reservation_name: 'Avery',
        service_type: 'hotel',
        date: '2026-04-07',
        start_time: '14:00',
        status: 'confirmed',
      },
    });

    expect(payload.text).toBe('Booking confirm');
    expect(payload.blocks[0].text.text).toContain('Name: Avery');
    expect(payload.blocks[0].text.text).toContain('Status: confirmed');
  });

  it('formats a teams-compatible webhook payload', async () => {
    const { formatWebhookPayload } = await import('../services/notifications.js');
    const payload = formatWebhookPayload({
      type: 'waitlist_open',
      isVip: true,
      provider: 'teams',
      booking: {
        reservation_name: 'Jordan',
        service_type: 'restaurant',
        date: '2026-04-08',
        start_time: '18:30',
        status: 'pending',
      },
    });

    expect(payload['@type']).toBe('MessageCard');
    expect(payload.title).toBe('VIP Booking');
    expect(payload.sections[0].text).toContain('Name: Jordan');
    expect(payload.sections[0].text).toContain('Status: pending');
  });

  it('sends a webhook for booking notifications', async () => {
    const { notifyBooking } = await import('../services/notifications.js');
    await notifyBooking({
      type: 'confirm',
      booking: {
        reservation_name: 'Avery',
        service_type: 'hotel',
        date: '2026-04-07',
        start_time: '14:00',
        status: 'confirmed',
      },
      isVip: false,
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, init] = global.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.text).toBe('Booking confirm');
    expect(body.blocks[0].text.text).toContain('Type: hotel');
  });
});
