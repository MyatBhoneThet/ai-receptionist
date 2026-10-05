import { checkAvailability, serviceFkColumn } from './availability.js';
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

function invalid(message, availability) {
  return { valid: false, message, ...(availability ? { availability } : {}) };
}

/** Validate a proposed amendment without writing to the database or Calendar.
 * `assignments` contains the safe values to persist, including any preserved
 * duration or allocation needed to keep the booking consistent.
 */
export async function validateBookingAlteration(currentBooking, changes) {
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
    if (endTime <= startTime) {
      return invalid('The end time must be after the start time. What time would you like instead?');
    }
  }

  const fkColumn = serviceFkColumn(amended.service_type);
  const currentResourceId = Number(currentBooking[fkColumn]) || null;
  let availability;
  try {
    availability = await checkAvailability({
      service_type: amended.service_type,
      date: startDate,
      end_date: endDate,
      start_time: startTime === null ? amended.start_time : timeText(startTime),
      end_time: endTime === null ? amended.end_time : timeText(endTime),
      people,
      ...(currentResourceId ? {} : { preferred_inventory: currentBooking.preferred_inventory }),
      exclude_booking_id: currentBooking.id || currentBooking.edit_booking_id,
    });
  } catch (error) {
    console.error('[booking alteration availability]', error.message);
    return invalid('I could not check availability just now. Your reservation has not been changed. Please try again.');
  }

  const currentOption = availability.options?.find((option) => Number(option.id) === currentResourceId);
  const currentIsAvailable = Boolean(currentOption?.available)
    && Number(currentOption.capacity) >= people;
  // A waitlist amendment does not claim an allocated resource or silently
  // promote the reservation to a confirmed booking.
  if (currentBooking.waitlisted === true) {
    assignments.waitlisted = true;
    if (currentResourceId && !currentIsAvailable) assignments[fkColumn] = null;
    return { valid: true, assignments, availability };
  }
  if (currentResourceId && !currentIsAvailable) {
    return invalid(`Your current ${RESOURCE_NAMES[amended.service_type]} is unavailable for those details. Please choose a different date, time, or guest count.`, availability);
  }
  if (!currentResourceId) {
    const selected = availability.selected_option;
    if (!selected?.available || Number(selected.capacity) < people || !Number.isInteger(Number(selected.id)) || Number(selected.id) < 1) {
      return invalid('There is no availability for those details. Please choose a different date, time, or guest count.', availability);
    }
    assignments[fkColumn] = Number(selected.id);
    assignments.waitlisted = false;
  }
  return { valid: true, assignments, availability };
}
