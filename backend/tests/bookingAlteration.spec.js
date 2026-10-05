import { jest } from '@jest/globals';

const checkAvailability = jest.fn();
await jest.unstable_mockModule('../services/availability.js', () => ({
  checkAvailability,
  serviceFkColumn: (type) => ({ hotel: 'hotel_room_id', restaurant: 'table_id', meeting: 'meeting_room_id' })[type],
}));
const { validateBookingAlteration } = await import('../services/bookingAlteration.js');

const restaurant = {
  id: 42, service_type: 'restaurant', date: '2026-10-14',
  start_time: '18:30:00', end_time: '19:30:00', people: 4,
  table_id: 3, waitlisted: false, reservation_name: 'Steward',
};
const assignedTable = { id: 3, capacity: 6, available: true };
const otherTable = { id: 1, capacity: 8, available: true };

describe('booking alteration validation', () => {
  beforeEach(() => {
    checkAvailability.mockReset().mockResolvedValue({
      available: 2, total: 2, waitlist: false,
      options: [otherTable, assignedTable], selected_option: otherTable,
    });
  });

  it('preserves the assigned table and excludes this booking from occupancy checks', async () => {
    const result = await validateBookingAlteration(restaurant, { date: '16-10-2026', people: 5 });
    expect(result).toMatchObject({ valid: true, assignments: { date: '16-10-2026', people: 5 } });
    expect(result.assignments).not.toHaveProperty('table_id');
    expect(checkAvailability).toHaveBeenCalledWith({
      service_type: 'restaurant', date: '2026-10-16', end_date: undefined,
      start_time: '18:30', end_time: '19:30', people: 5, exclude_booking_id: 42,
    });
    expect(restaurant.date).toBe('2026-10-14');
  });

  it('does not silently move a booking to another free resource', async () => {
    checkAvailability.mockResolvedValue({
      available: 1, waitlist: false, selected_option: otherTable,
      options: [otherTable, { ...assignedTable, available: false }],
    });
    const result = await validateBookingAlteration(restaurant, { date: '16-10-2026' });
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/current table is unavailable/i);
    expect(result).not.toHaveProperty('assignments');
  });

  it('rejects guest increases beyond the assigned resource capacity', async () => {
    checkAvailability.mockResolvedValue({
      available: 1, waitlist: false, selected_option: otherTable, options: [otherTable],
    });
    expect((await validateBookingAlteration(restaurant, { people: 7 })).valid).toBe(false);
  });

  it('checks the selected meeting room rather than the hotel or restaurant allocation', async () => {
    checkAvailability.mockResolvedValue({ options: [{ id: 7, capacity: 12, available: true }] });
    const meeting = { ...restaurant, service_type: 'meeting', table_id: null, meeting_room_id: 7 };
    const result = await validateBookingAlteration(meeting, { people: 10 });
    expect(result.valid).toBe(true);
    expect(result.assignments).toEqual({ people: 10 });
    expect(checkAvailability).toHaveBeenCalledWith(expect.objectContaining({ service_type: 'meeting', exclude_booking_id: 42 }));
  });

  it('does not treat an available but undersized assigned resource as adequate', async () => {
    const result = await validateBookingAlteration(restaurant, { people: 7 });
    expect(result.valid).toBe(false);
  });

  it('keeps the existing duration when changing only the start time', async () => {
    const result = await validateBookingAlteration(restaurant, { start_time: '20:00' });
    expect(result.assignments).toEqual({ start_time: '20:00', end_time: '21:00' });
    expect(checkAvailability).toHaveBeenCalledWith(expect.objectContaining({ start_time: '20:00', end_time: '21:00' }));
  });

  it('validates an explicit end time instead of overriding it', async () => {
    const result = await validateBookingAlteration(restaurant, { start_time: '20:00', end_time: '22:00' });
    expect(result.assignments).toEqual({ start_time: '20:00', end_time: '22:00' });
  });

  it.each([
    [{ date: '31-02-2026' }, /date is not valid/i],
    [{ start_time: '25:00' }, /time is not valid/i],
    [{ start_time: '18:61' }, /time is not valid/i],
    [{ start_time: '23:30' }, /past midnight/i],
    [{ end_time: '18:00' }, /end time must be after/i],
    [{ people: 2.5 }, /whole number/i],
    [{ people: 0 }, /whole number/i],
    [{ people: -1 }, /whole number/i],
    [{ reservation_name: '' }, /reservation name/i],
    [{ contact_phone: '12345' }, /valid phone number/i],
    [{ service_type: 'hotel' }, /you can change/i],
  ])('rejects invalid values before checking inventory: %j', async (changes, expectedMessage) => {
    const result = await validateBookingAlteration(restaurant, changes);
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(expectedMessage);
    expect(checkAvailability).not.toHaveBeenCalled();
  });

  it('validates hotel nights while allowing a morning checkout after afternoon arrival', async () => {
    checkAvailability.mockResolvedValue({ options: [{ id: 3, capacity: 6, available: true }] });
    const hotel = {
      ...restaurant, service_type: 'hotel', table_id: null, hotel_room_id: 3,
      date: new Date(2026, 9, 14), end_date: new Date(2026, 9, 17),
      start_time: '14:00:00', end_time: '11:00:00',
    };
    const result = await validateBookingAlteration(hotel, { date: '15-10-2026', end_date: '18-10-2026' });
    expect(result.valid).toBe(true);
    expect(checkAvailability).toHaveBeenCalledWith(expect.objectContaining({
      date: '2026-10-15', end_date: '2026-10-18', start_time: '14:00', end_time: '11:00',
    }));
  });

  it('rejects a same-day hotel checkout before checking inventory', async () => {
    const result = await validateBookingAlteration({ ...restaurant, service_type: 'hotel', end_date: '2026-10-17' },
      { end_date: '14-10-2026' });
    expect(result).toMatchObject({ valid: false, message: expect.stringMatching(/check-out date must be after/i) });
    expect(checkAvailability).not.toHaveBeenCalled();
  });

  it('does not write hotel check-out dates onto a restaurant reservation', async () => {
    const result = await validateBookingAlteration(restaurant, { end_date: '16-10-2026' });
    expect(result).toMatchObject({ valid: false, message: expect.stringMatching(/single date/i) });
    expect(checkAvailability).not.toHaveBeenCalled();
  });

  it('preserves the local date of a SQL DATE when editing guests', async () => {
    const result = await validateBookingAlteration({ ...restaurant, date: new Date(2026, 9, 14) }, { people: 5 });
    expect(result.valid).toBe(true);
    expect(checkAvailability).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-10-14' }));
  });

  it('assigns a free resource for a previously unallocated active reservation', async () => {
    const result = await validateBookingAlteration({ ...restaurant, table_id: null }, { people: 5 });
    expect(result.assignments).toEqual({ people: 5, table_id: 1, waitlisted: false });
  });

  it('rejects an unallocated active reservation when no resource can accommodate it', async () => {
    checkAvailability.mockResolvedValue({ available: 0, waitlist: true, selected_option: null, options: [] });
    expect((await validateBookingAlteration({ ...restaurant, table_id: null }, { people: 5 })).valid).toBe(false);
  });

  it('allows waitlisted details to change while keeping the reservation on the waitlist', async () => {
    checkAvailability.mockResolvedValue({ available: 0, waitlist: true, selected_option: null, options: [] });
    const result = await validateBookingAlteration({ ...restaurant, waitlisted: true, table_id: null }, { date: '16-10-2026' });
    expect(result).toMatchObject({ valid: true, assignments: { date: '16-10-2026', waitlisted: true } });
    expect(result.assignments).not.toHaveProperty('table_id');
  });

  it('does not silently confirm a waitlisted booking when a resource becomes free', async () => {
    const result = await validateBookingAlteration({ ...restaurant, waitlisted: true, table_id: null }, { people: 5 });
    expect(result.assignments).toEqual({ people: 5, waitlisted: true });
  });

  it('clears an unusable allocation for a waitlisted reservation', async () => {
    checkAvailability.mockResolvedValue({ available: 0, waitlist: true, selected_option: null, options: [] });
    const result = await validateBookingAlteration({ ...restaurant, waitlisted: true }, { people: 7 });
    expect(result.assignments).toEqual({ people: 7, waitlisted: true, table_id: null });
  });

  it('edits contact details without requiring new availability', async () => {
    const changes = { contact_phone: '+66 (80) 123-4567', reservation_name: 'Henry', notes: 'Window if possible' };
    const result = await validateBookingAlteration({ ...restaurant, date: null }, changes);
    expect(result).toEqual({ valid: true, assignments: {
      contact_phone: '+66801234567', reservation_name: 'Henry', notes: 'Window if possible',
    } });
    expect(changes.contact_phone).toBe('+66 (80) 123-4567');
    expect(checkAvailability).not.toHaveBeenCalled();
  });

  it('refuses to claim success when availability cannot be checked', async () => {
    checkAvailability.mockRejectedValue(new Error('database unavailable'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await validateBookingAlteration(restaurant, { people: 5 });
    expect(result).toMatchObject({ valid: false, message: expect.stringMatching(/has not been changed/i) });
    expect(result).not.toHaveProperty('assignments');
    log.mockRestore();
  });
});
