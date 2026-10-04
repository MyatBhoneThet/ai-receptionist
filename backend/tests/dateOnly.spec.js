import { formatDateKey, formatDisplayDateValue } from '../services/dateOnly.js';

describe('date-only formatting', () => {
  it('preserves the local calendar day for SQL DATE objects', () => {
    const juneTwentieth = new Date(2026, 5, 20);

    expect(formatDateKey(juneTwentieth)).toBe('2026-06-20');
    expect(formatDisplayDateValue(juneTwentieth)).toBe('20-06-2026');
  });

  it('formats ISO date strings for receptionist summaries', () => {
    expect(formatDisplayDateValue('2026-06-20')).toBe('20-06-2026');
  });
});
