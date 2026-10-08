import { bookingDateKey, displayBookingDate } from './bookingDates.js';
import { formatDisplayDateValue } from './dateOnly.js';

const EDITABLE_FIELDS = new Set([
  'date', 'end_date', 'start_time', 'end_time', 'people',
  'contact_phone', 'reservation_name', 'notes',
]);
const SCHEDULE_FIELDS = ['date', 'end_date', 'start_time', 'end_time', 'people'];
const RESOURCE_NAMES = { hotel: 'room', restaurant: 'table', meeting: 'meeting room' };

function dateKey(value) {
  return bookingDateKey(value instanceof Date ? formatDisplayDateValue(value) : value);
}

function timeMinutes(value) {
  const match = String(value ?? '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  return hours < 24 && minutes < 60 && seconds < 60
    ? hours * 60 + minutes + seconds / 60 : null;
}

function timeText(minutes) {
  const totalSeconds = Math.round(minutes * 60);
  const hours = Math.floor(totalSeconds / 3600);
  const remainder = totalSeconds % 3600;
  const result = `${String(hours).padStart(2, '0')}:${String(Math.floor(remainder / 60)).padStart(2, '0')}`;
  return remainder % 60 ? `${result}:${String(remainder % 60).padStart(2, '0')}` : result;
}

function invalid(message) {
  return { valid: false, message };
}

/** Check the SHAPE of a guest's requested amendment (valid dates, times, guest
 * count, phone) and produce friendly prompts. It decides nothing about
 * availability, capacity or price: those are enforced by the shared booking
 * layer when the change is applied, in the same transaction as the write.
 * `assignments` holds the normalized values, including a preserved duration.
 */
export function normalizeBookingAlteration(currentBooking, changes) {
  if (!currentBooking || !changes || Object.keys(changes).length === 0) {
    return invalid('What would you like to change in your reservation?');
  }
  if (Object.keys(changes).some((field) => !EDITABLE_FIELDS.has(field))) {
    return invalid('You can change the date, time, guests, phone number, reservation name, or notes.');
  }
  const assignments = { ...changes };
  for (const field of ['date', 'end_date']) {
    if (!(field in changes)) continue;
    const key = dateKey(changes[field]);
    if (!key) return invalid('That date is not valid. What date would you like instead?');
    assignments[field] = displayBookingDate(key);
  }
  for (const field of ['start_time', 'end_time']) {
    if (!(field in changes)) continue;
    const minutes = timeMinutes(changes[field]);
    if (minutes === null) return invalid('That time is not valid. What time would you like instead?');
    assignments[field] = timeText(minutes);
  }
  if ('people' in changes) {
    const count = Number(changes.people);
    if (!Number.isSafeInteger(count) || count < 1) {
      return invalid('Please give a whole number of guests greater than zero.');
    }
    assignments.people = count;
  }
  if ('reservation_name' in changes && !String(changes.reservation_name ?? '').trim()) {
    return invalid('What reservation name should I use?');
  }
  if ('contact_phone' in changes) {
    const phone = String(changes.contact_phone ?? '').trim();
    const digits = phone.replace(/\D/g, '');
    if (!/^\+?[\d ()-]+$/.test(phone) || digits.length < 7 || digits.length > 15) {
      return invalid('Please provide a valid phone number for the reservation.');
    }
    assignments.contact_phone = `${phone.startsWith('+') ? '+' : ''}${digits}`;
  }

  // Contact-only changes must work even if a legacy booking has incomplete
  // scheduling fields or inventory is temporarily unavailable.
  if (!SCHEDULE_FIELDS.some((field) => field in assignments)) {
    return { valid: true, assignments };
  }
  const amended = { ...currentBooking, ...assignments };
  if (!Object.hasOwn(RESOURCE_NAMES, amended.service_type)) {
    return invalid('I could not determine the reservation type. Please find the reservation again.');
  }
  if (amended.service_type !== 'hotel' && 'end_date' in assignments) {
    return invalid('This reservation uses a single date. What date would you like instead?');
  }
  const startDate = dateKey(amended.date);
  if (!startDate) return invalid('What date would you like for the reservation?');
  const people = Number(amended.people);
  if (!Number.isSafeInteger(people) || people < 1) {
    return invalid('How many guests will the reservation be for?');
  }

  let endDate;
  let startTime = timeMinutes(amended.start_time);
  let endTime = timeMinutes(amended.end_time);
  if (amended.service_type === 'hotel') {
    endDate = dateKey(amended.end_date);
    if (!endDate || endDate <= startDate) {
      return invalid('The check-out date must be after the check-in date. What check-out date would you like?');
    }
  } else {
    if (startTime === null || endTime === null) {
      return invalid('Please provide a valid start and end time for the reservation.');
    }
    if ('start_time' in assignments && !('end_time' in assignments)) {
      const originalStart = timeMinutes(currentBooking.start_time);
      const originalEnd = timeMinutes(currentBooking.end_time);
      if (originalStart !== null && originalEnd !== null && originalEnd > originalStart) {
        endTime = startTime + originalEnd - originalStart;
        if (endTime >= 24 * 60) {
          return invalid('That start time would move the reservation past midnight. Please choose an earlier time.');
        }
        assignments.end_time = timeText(endTime);
      }
    }
    if (('start_time' in assignments || 'end_time' in assignments) && endTime <= startTime) {
      return invalid('The end time must be after the start time. What time would you like instead?');
    }
  }
  return { valid: true, assignments };
}
