import {
  calendarToday, extractNaturalBookingDate, bookingDateKey,
  addBookingDays, bookingStayDays,
} from '../services/bookingDates.js';

describe('booking calendar dates', () => {
  const today = '05-10-2026';

  it('anchors today to the calendar timezone across UTC midnight boundaries', () => {
    expect(calendarToday(new Date('2026-10-04T18:30:00Z'), 'Asia/Bangkok')).toBe('05-10-2026');
    expect(calendarToday(new Date('2026-10-04T18:30:00Z'), 'America/Los_Angeles')).toBe('04-10-2026');
  });

  it.each([
    ['day after tomorrow, not tomorrow', '07-10-2026'],
    ['not tomorrow, day after tomorrow', '07-10-2026'],
    ['seventh October this year', '07-10-2026'],
    ['October seventh, 2027', '07-10-2027'],
    ['twenty-first of October this year', '21-10-2026'],
    ['move it to 7/10/2026', '07-10-2026'],
    ['2026-10-07', '07-10-2026'],
    ['tomorrow', '06-10-2026'],
    ['18th next month', '18-11-2026'],
    ['next month on 18', '18-11-2026'],
    ['next Friday', '16-10-2026'],
  ])('parses %s without shifting day and month', (message, expected) => {
    expect(extractNaturalBookingDate(message, today)).toBe(expected);
  });

  it.each(['31-02-2026', '2026-13-07', 'thirty-first April this year', '29/02/2026'])('rejects invalid calendar date %s', (value) => {
    expect(extractNaturalBookingDate(value, today)).toBe('');
    expect(bookingDateKey(value)).toBeNull();
  });

  it('keeps leap-day and hotel durations valid across month/year boundaries', () => {
    expect(bookingDateKey('29-02-2028')).toBe('2028-02-29');
    expect(addBookingDays('30-12-2026', 3)).toBe('02-01-2027');
    expect(bookingStayDays('30-12-2026', '02-01-2027')).toBe(3);
    expect(bookingStayDays('02-01-2027', '30-12-2026')).toBeNull();
  });
});
