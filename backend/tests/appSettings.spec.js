import { buildChangeSummary } from '../services/appSettings.js';

describe('appSettings helpers', () => {
  it('builds a field-level change summary', () => {
    const summary = buildChangeSummary(
      { provider: 'slack', webhook_url: 'https://old.example', alert_email: 'old@hotel.com' },
      { provider: 'teams', webhook_url: 'https://new.example', alert_email: 'old@hotel.com' }
    );

    expect(summary).toEqual([
      { field: 'provider', before: 'slack', after: 'teams' },
      { field: 'webhook_url', before: 'https://old.example', after: 'https://new.example' },
    ]);
  });
});
