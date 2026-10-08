// Input normalization for guest amendments. Availability, capacity and price
// are deliberately NOT decided here — see tests/integration/bookingEngine.spec.js
// and chatRegression.spec.js, where they are enforced against real PostgreSQL.
import { normalizeBookingAlteration } from '../services/bookingAlteration.js';

const restaurant = {
  id: 42, service_type: 'restaurant', date: '2026-10-14', start_time: '19:00:00', end_time: '20:00:00',
  people: 4, reservation_name: 'Steward', contact_phone: '0801111111', notes: '', waitlisted: false,
};
const hotel = { ...restaurant, service_type: 'hotel', end_date: '2026-10-16', start_time: '14:00:00', end_time: '11:00:00' };

describe('booking alteration normalization', () => {
  it('asks what to change when nothing is supplied', () => {
    expect(normalizeBookingAlteration(restaurant, {})).toMatchObject({ valid: false });
    expect(normalizeBookingAlteration(null, { people: 2 })).toMatchObject({ valid: false });
  });

  it('rejects fields a guest may not edit', () => {
    const result = normalizeBookingAlteration(restaurant, { status: 'confirmed' });
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/date, time, guests/);
  });

  it('normalizes dates to display form and times to HH:MM', () => {
    const result = normalizeBookingAlteration(restaurant, { date: '2026-10-15', start_time: '18:30:00' });
    expect(result).toMatchObject({ valid: true, assignments: { date: '15-10-2026', start_time: '18:30' } });
  });

  it('keeps the existing duration when changing only the start time', () => {
    const result = normalizeBookingAlteration(restaurant, { start_time: '20:00' });
    expect(result.assignments).toMatchObject({ start_time: '20:00', end_time: '21:00' });
  });

  it('validates an explicit end time instead of overriding it', () => {
    expect(normalizeBookingAlteration(restaurant, { start_time: '20:00', end_time: '22:30' }).assignments)
      .toMatchObject({ start_time: '20:00', end_time: '22:30' });
    const backwards = normalizeBookingAlteration(restaurant, { end_time: '18:00' });
    expect(backwards.valid).toBe(false);
    expect(backwards.message).toMatch(/end time must be after the start time/);
  });

  it('does not move a preserved duration past midnight', () => {
    const result = normalizeBookingAlteration(restaurant, { start_time: '23:30' });
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/past midnight/);
  });

  it('validates hotel nights while allowing a morning checkout after afternoon arrival', () => {
    expect(normalizeBookingAlteration(hotel, { date: '15-10-2026', end_date: '18-10-2026' }))
      .toMatchObject({ valid: true, assignments: { date: '15-10-2026', end_date: '18-10-2026' } });
  });

  it('rejects a same-day hotel checkout', () => {
    const result = normalizeBookingAlteration(hotel, { end_date: '14-10-2026' });
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/check-out date must be after/);
  });

  it('does not write hotel check-out dates onto a restaurant reservation', () => {
    const result = normalizeBookingAlteration(restaurant, { end_date: '16-10-2026' });
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/single date/);
  });

  it('preserves the local date of a SQL DATE when editing guests', () => {
    const result = normalizeBookingAlteration({ ...restaurant, date: new Date(2026, 9, 14) }, { people: 6 });
    expect(result).toMatchObject({ valid: true, assignments: { people: 6 } });
  });

  it('requires a whole, positive guest count and a plausible phone number', () => {
    expect(normalizeBookingAlteration(restaurant, { people: 0 }).valid).toBe(false);
    expect(normalizeBookingAlteration(restaurant, { people: 2.5 }).valid).toBe(false);
    expect(normalizeBookingAlteration(restaurant, { contact_phone: '12' }).valid).toBe(false);
    expect(normalizeBookingAlteration(restaurant, { contact_phone: '+66 80-111 2222' }).assignments.contact_phone).toBe('+66801112222');
  });

  it('edits contact details even when a legacy booking has incomplete scheduling fields', () => {
    const legacy = { ...restaurant, start_time: null, end_time: null };
    expect(normalizeBookingAlteration(legacy, { reservation_name: 'May', notes: 'Window seat' }))
      .toMatchObject({ valid: true, assignments: { reservation_name: 'May', notes: 'Window seat' } });
  });
});
