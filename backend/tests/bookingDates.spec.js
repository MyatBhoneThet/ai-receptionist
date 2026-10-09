import {
  calendarToday, extractNaturalBookingDate, bookingDateKey,
  addBookingDays, bookingStayDays, resolveNaturalBookingDate,
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
    ['next Friday', '09-10-2026'],
  ])('parses %s without shifting day and month', (message, expected) => {
    expect(extractNaturalBookingDate(message, today)).toBe(expected);
  });

  it.each([
    ['next Tuesday', '13-10-2026'],
    ['Tuesday', '13-10-2026'],
    ['next Friday', '16-10-2026'],
    ['this Friday', '09-10-2026'],
    ['next week on Tuesday', '13-10-2026'],
    ['Tuesday next week', '13-10-2026'],
    ['this week on Tuesday', '06-10-2026'],
    ['tomorrow', '10-10-2026'],
    ['day after tomorrow', '11-10-2026'],
    ['Tuesday or Wednesday', ''],
    ['change my meeting to Tuesday or Wednesday', ''],
    ['book a meeting from 13-10-2026 to 14-10-2026', ''],
    ['move from 13-10-2026 to 14-10-2026', '14-10-2026'],
    ['13-10-2026, actually 14-10-2026', '14-10-2026'],
    ['Tuesday 13-10-2026', '13-10-2026'],
    ['Tuesday 14-10-2026', ''],
    ['13-10-2026 or 31-02-2026', ''],
    ['0803245774', ''],
  ])('resolves %s from the screenshot date, Friday October 9', (message, expected) => {
    expect(extractNaturalBookingDate(message, '09-10-2026')).toBe(expected);
  });

  it('handles upcoming weekdays across the year boundary', () => {
    expect(extractNaturalBookingDate('next Tuesday', '31-12-2026')).toBe('05-01-2027');
    expect(extractNaturalBookingDate('next Thursday', '31-12-2026')).toBe('07-01-2027');
    expect(extractNaturalBookingDate('this Thursday', '31-12-2026')).toBe('31-12-2026');
  });

  it('distinguishes missing, invalid, and conflicting dates for clarification', () => {
    expect(resolveNaturalBookingDate('seven guests', today).status).toBe('absent');
    expect(resolveNaturalBookingDate('31-02-2026', today).status).toBe('invalid');
    expect(resolveNaturalBookingDate('Tuesday or Wednesday', today).status).toBe('ambiguous');
    expect(resolveNaturalBookingDate('next Tuesday', '09-10-2026')).toEqual({ date: '13-10-2026', status: 'resolved' });
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
