import { resolveBookingService } from '../services/bookingService.js';

describe('reservation service selection', () => {
  it.each([
    ['meeting', 'meeting'],
    ['meeting, not booking', 'meeting'],
    ['the type of reservation is meeting, not booking', 'meeting'],
    ['reservation type is meeting', 'meeting'],
    ['the reservation type: meeting', 'meeting'],
    ['the type is meeting', 'meeting'],
    ['The date is next Wednesday and the table reservation is meeting and the name is Steward', 'meeting'],
    ['Change my restaurant reservation — actually meeting', 'meeting'],
    ['restaurant, actually meeting', 'meeting'],
    ['not restaurant, meeting', 'meeting'],
    ["It isn't a restaurant reservation; it is a meeting", 'meeting'],
    ["I don't want a hotel room; I want a meeting room", 'meeting'],
    ['a meeting, not a restaurant reservation', 'meeting'],
    ['not a hotel room; it is a meeting room', 'meeting'],
    ['meeting room', 'meeting'],
    ['conference room', 'meeting'],
    ['book a meeting room for a restaurant presentation', 'meeting'],
    ['hotel room', 'hotel'],
    ['a hotel room, not a meeting', 'hotel'],
    ['restaurant', 'restaurant'],
    ['table reservation', 'restaurant'],
    ['dinner reservation', 'restaurant'],
    ['restaurant booking', 'restaurant'],
    ['type of reservation is restaurant; the meeting is after dinner', 'restaurant'],
    ['reservation type is hotel and we will have a meeting in the room', 'hotel'],
    ['my booking is meeting and we need a table', 'meeting'],
  ])('resolves "%s" to %s', (message, serviceType) => {
    const result = resolveBookingService(message);
    expect(result.service_type).toBe(serviceType);
    expect(result.ambiguous).toBe(false);
    expect(result.candidates).toContain(serviceType);
  });

  it.each([
    ['', []],
    ['booking', []],
    ['reservation', []],
    ['I would like to alter a booking', []],
    ['not a restaurant booking', []],
    ['Steward', []],
  ])('does not invent a reservation type from "%s"', (message, candidates) => {
    expect(resolveBookingService(message)).toMatchObject({
      service_type: '', ambiguous: false, candidates,
    });
  });

  it.each([
    ['hotel or restaurant', ['hotel', 'restaurant']],
    ['meeting and restaurant', ['meeting', 'restaurant']],
    ['hotel room or meeting room', ['hotel', 'meeting']],
    ['reservation type is meeting or restaurant', ['meeting', 'restaurant']],
  ])('asks for clarification when "%s" contains equally explicit alternatives', (message, candidates) => {
    const result = resolveBookingService(message);
    expect(result.service_type).toBe('');
    expect(result.ambiguous).toBe(true);
    expect([...result.candidates].sort()).toEqual([...candidates].sort());
  });

  it('normalizes capitalization and collapses repeated mentions of the same type', () => {
    const result = resolveBookingService('MEETING reservation, for the meeting room');
    expect(result).toMatchObject({service_type: 'meeting', ambiguous: false});
    expect(result.candidates).toEqual(['meeting']);
  });
});
