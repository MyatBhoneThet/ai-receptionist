import { query } from './db.js';

/**
 * Availability check using the three explicit resource tables
 * (hotel_rooms, restaurant_tables, meeting_rooms) + bookings.
 *
 * Returns:
 *   available          — number of free slots matching the request
 *   total              — total slots in scope
 *   waitlist           — true if available === 0
 *   selected_option    — the first available resource (to store on the booking)
 *   options            — all resources with availability counts
 *   other_options      — alternatives when preferred is full
 *   occupied_option    — the requested resource if it was full
 *   place_recommendation — best alternative if preferred is full
 *   reason             — 'available' | 'full' | 'no_matching_inventory' | 'invalid_date' | etc.
 */
export async function checkAvailability({
  service_type,
  date,
  end_date,
  start_time,
  end_time,
  people,
  preferred_inventory,
  exclude_booking_id,
}) {
  const requestedPeople = normalizePeople(people);
  const normalizedDate = normalizeDateForDb(date);
  const normalizedEndDate =
    service_type === 'hotel'
      ? normalizeDateForDb(end_date) || addDays(normalizedDate, 1)
      : null;

  if (!normalizedDate) {
    return { ...emptyAvailability(), reason: 'invalid_date' };
  }

  // ── 1. Load relevant resources from the right table ──────────────
  const resources = await loadResources(service_type, requestedPeople);
  if (resources.length === 0) {
    return { ...emptyAvailability(), reason: 'no_matching_inventory' };
  }

  // ── 2. Load active (non-cancelled, non-waitlisted) bookings ──────
  const fkColumn = serviceFkColumn(service_type);
  const bookingResult = await query(
    `SELECT id, ${fkColumn} AS resource_id, people, date, end_date, start_time, end_time
     FROM bookings
     WHERE service_type = $1
       AND status NOT IN ('cancelled', 'no_show')
       AND waitlisted = FALSE
       AND ($2::int IS NULL OR id <> $2)`,
    [service_type, normalizeOptionalId(exclude_booking_id)]
  );

  const matchingBookings = bookingResult.rows.filter((booking) =>
    overlapsRequest({ service_type, booking, date: normalizedDate, end_date: normalizedEndDate, start_time, end_time })
  );

  // ── 3. Compute availability per resource ─────────────────────────
  const options = allocateAvailability(resources, matchingBookings);
  const preferredOptions = filterPreferredOptions(options, preferred_inventory);
  const selectableOptions = preferred_inventory ? preferredOptions : options;

  const total     = selectableOptions.reduce((s, o) => s + 1, 0); // each resource = 1 slot
  const available = selectableOptions.filter((o) => o.available).length;
  const selected  = selectableOptions.find((o) => o.available) || null;

  const otherAvailableOptions = preferred_inventory
    ? options.filter((o) => !selectableOptions.some((s) => s.id === o.id) && o.available)
    : [];

  const occupiedPreferredOption = preferred_inventory
    ? preferredOptions.find((o) => !o.available) || null
    : null;

  return {
    available,
    total,
    waitlist: available === 0,
    selected_option: selected ? serializeOption(selected) : null,
    options: options.map(serializeOption),
    other_options: otherAvailableOptions.map(serializeOption),
    occupied_option: occupiedPreferredOption ? serializeOption(occupiedPreferredOption) : null,
    place_recommendation: otherAvailableOptions[0] ? serializeOption(otherAvailableOptions[0]) : null,
    reason:
      available === 0
        ? preferred_inventory && preferredOptions.length === 0
          ? 'requested_type_not_found'
          : 'full'
        : 'available',
  };
}

export async function findAlternativeAvailability({
  service_type,
  date,
  end_date,
  start_time,
  end_time,
  people,
  preferred_inventory,
  daysToScan = 7,
}) {
  const baseDate = normalizeDateForDb(date);
  if (!baseDate) return null;

  // For non-hotel: try same date with alternate place first
  if (service_type !== 'hotel') {
    const sameTimeResult = await checkAvailability({
      service_type, date: baseDate, start_time, end_time, people, preferred_inventory,
    });
    if (sameTimeResult.place_recommendation) {
      return {
        date: toDisplayDate(baseDate),
        start_time,
        end_time,
        available: sameTimeResult.place_recommendation.available ? 1 : 0,
        total: 1,
        selected_option: sameTimeResult.place_recommendation,
        recommendation_type: 'place',
      };
    }

    // Try nearby time slots
    const requestedStart = timeToMinutes(start_time) ?? 12 * 60;
    const durationMinutes = Math.max((timeToMinutes(end_time) ?? requestedStart + 60) - requestedStart, 30);
    for (const offset of nearestTimeOffsets()) {
      const candidateStartMinutes = requestedStart + offset;
      if (candidateStartMinutes < 0 || candidateStartMinutes + durationMinutes > 24 * 60) continue;
      const candidateStart = minutesToTime(candidateStartMinutes);
      const candidateEnd   = minutesToTime(candidateStartMinutes + durationMinutes);
      const result = await checkAvailability({
        service_type, date: baseDate, start_time: candidateStart, end_time: candidateEnd, people, preferred_inventory,
      });
      if (!result.waitlist && result.available > 0) {
        return {
          date: toDisplayDate(baseDate),
          start_time: candidateStart,
          end_time: candidateEnd,
          available: result.available,
          total: result.total,
          selected_option: result.selected_option,
          recommendation_type: 'time',
        };
      }
    }
  }

  // Try future dates
  const stayLengthDays =
    service_type === 'hotel'
      ? Math.max(diffDays(baseDate, normalizeDateForDb(end_date) || addDays(baseDate, 1)), 1)
      : 0;

  for (let i = 1; i <= daysToScan; i++) {
    const candidateDate    = addDays(baseDate, i);
    const candidateEndDate = service_type === 'hotel' ? addDays(candidateDate, stayLengthDays) : undefined;
    const result = await checkAvailability({
      service_type, date: candidateDate, end_date: candidateEndDate, start_time, end_time, people, preferred_inventory,
    });
    if (!result.waitlist && result.available > 0) {
      return {
        date: toDisplayDate(candidateDate),
        end_date: candidateEndDate ? toDisplayDate(candidateEndDate) : undefined,
        start_time, end_time,
        available: result.available,
        total: result.total,
        selected_option: result.selected_option,
        recommendation_type: 'date',
      };
    }
  }

  return null;
}

export async function findDuplicateBooking({
  service_type,
  date,
  end_date,
  start_time,
  end_time,
  reservation_name,
  contact_phone,
  hotel_room_id,
  table_id,
  meeting_room_id,
  exclude_booking_id,
}) {
  const normalizedDate = normalizeDateForDb(date);
  if (!service_type || !normalizedDate || !reservation_name) return null;

  const result = await query(
    `SELECT id, session_id, service_type, date, end_date, start_time, end_time,
            reservation_name, contact_phone,
            hotel_room_id, table_id, meeting_room_id, status
     FROM bookings
     WHERE service_type = $1
       AND status IN ('pending', 'confirmed', 'modified')
       AND ($2::int IS NULL OR id <> $2)`,
    [service_type, normalizeOptionalId(exclude_booking_id)]
  );

  const normalizedName    = normalizeComparableText(reservation_name);
  const normalizedPhone   = normalizePhone(contact_phone);
  const normalizedEndDate =
    service_type === 'hotel'
      ? normalizeDateForDb(end_date) || addDays(normalizedDate, 1)
      : null;
  const normalizedStartTime = normalizeTimeKey(start_time);
  const normalizedEndTime   = normalizeTimeKey(end_time);

  return (
    result.rows.find((booking) => {
      if (normalizeComparableText(booking.reservation_name) !== normalizedName) return false;
      const bookingPhone = normalizePhone(booking.contact_phone);
      if (normalizedPhone && bookingPhone && normalizedPhone !== bookingPhone) return false;
      if (normalizeDateForDb(booking.date) !== normalizedDate) return false;

      if (service_type === 'hotel') {
        const bookingEndDate = normalizeDateForDb(booking.end_date) || addDays(normalizedDate, 1);
        return bookingEndDate === normalizedEndDate;
      }
      return (
        normalizeTimeKey(booking.start_time) === normalizedStartTime &&
        normalizeTimeKey(booking.end_time)   === normalizedEndTime
      );
    }) || null
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Return the correct FK column name on bookings for each service_type */
export function serviceFkColumn(service_type) {
  switch (service_type) {
    case 'hotel':      return 'hotel_room_id';
    case 'restaurant': return 'table_id';
    case 'meeting':    return 'meeting_room_id';
    default:           return 'hotel_room_id';
  }
}

/** Load all active resources for the given service type that can fit the party */
async function loadResources(service_type, minCapacity) {
  let result;
  switch (service_type) {
    case 'hotel':
      result = await query(
        `SELECT id, room_number AS code, room_type AS name, capacity,
                floor, price_per_night, amenities AS metadata
         FROM hotel_rooms
         WHERE is_active = TRUE AND capacity >= $1
         ORDER BY floor ASC, room_number ASC`,
        [minCapacity]
      );
      break;
    case 'restaurant':
      result = await query(
        `SELECT id, table_number AS code, location AS name, capacity,
                NULL::numeric AS price_per_night, '{}'::jsonb AS metadata
         FROM restaurant_tables
         WHERE is_active = TRUE AND capacity >= $1
         ORDER BY capacity ASC, table_number ASC`,
        [minCapacity]
      );
      break;
    case 'meeting':
      result = await query(
        `SELECT id, room_code AS code, room_name AS name, capacity,
                NULL::numeric AS price_per_night, equipment AS metadata
         FROM meeting_rooms
         WHERE is_active = TRUE AND capacity >= $1
         ORDER BY capacity ASC, room_code ASC`,
        [minCapacity]
      );
      break;
    default:
      return [];
  }
  return result.rows.map((r) => ({
    ...r,
    id:       Number(r.id),
    capacity: Number(r.capacity || 0),
  }));
}

/** Mark each resource as available or not based on overlapping bookings */
function allocateAvailability(resources, bookings) {
  const options = resources.map((r) => ({ ...r, available: true }));

  for (const booking of bookings) {
    const resourceId = booking.resource_id ? Number(booking.resource_id) : null;
    const target = resourceId
      ? options.find((o) => o.id === resourceId || Math.floor(o.id / 1000) === resourceId)
      : options.find((o) => o.available); // fallback: any available one
    if (target) {
      target.available = false;
    }
  }

  return options;
}

/** Filter resources by a loose text preference (room type, location, etc.) */
function filterPreferredOptions(options, preference) {
  const normalized = normalizePreference(preference);
  if (!normalized) return options;
  return options.filter((item) => {
    const haystack = [item.code, item.name, JSON.stringify(item.metadata || {})]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return normalized.every((token) => haystack.includes(token));
  });
}

function normalizePreference(value) {
  const text = String(value || '').toLowerCase().trim();
  if (!text) return null;
  const synonyms = {
    high: 'suite', higher: 'suite', highest: 'suite', luxury: 'suite', premium: 'suite',
    deluxe: 'deluxe', suite: 'suite', king: 'king', double: 'double', twin: 'twin',
    patio: 'patio', window: 'window', private: 'private', boardroom: 'boardroom',
    standard: 'standard', penthouse: 'penthouse',
  };
  const tokens = text
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => synonyms[t] || t);
  return [...new Set(tokens)];
}

function serializeOption(option) {
  return {
    id:       option.id,
    code:     option.code,
    name:     option.name,
    capacity: option.capacity,
    available: option.available,
    metadata: option.metadata || {},
  };
}

function overlapsRequest({ service_type, booking, date, end_date, start_time, end_time }) {
  const bookingStartDate = normalizeDateForDb(booking.date);
  if (!bookingStartDate) return false;

  if (service_type === 'hotel') {
    const bookingEndDate = normalizeDateForDb(booking.end_date) || addDays(bookingStartDate, 1);
    return bookingStartDate < end_date && bookingEndDate > date;
  }

  if (bookingStartDate !== date) return false;
  const requestedStart = timeToMinutes(start_time) ?? 0;
  const requestedEnd   = timeToMinutes(end_time)   ?? requestedStart + 60;
  const bookingStart   = timeToMinutes(booking.start_time) ?? 0;
  const bookingEnd     = timeToMinutes(booking.end_time)   ?? bookingStart + 60;
  return bookingStart < requestedEnd && bookingEnd > requestedStart;
}

function emptyAvailability() {
  return { available: 0, total: 0, waitlist: true, selected_option: null, options: [], reason: 'unavailable' };
}

function normalizePeople(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeOptionalId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeDateForDb(input) {
  if (!input) return null;
  if (input instanceof Date) return input.toISOString().slice(0, 10);
  if (typeof input !== 'string') return null;
  const dmY = input.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmY) {
    const [, dd, mm, yyyy] = dmY;
    return `${yyyy}-${mm}-${dd}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  return null;
}

function timeToMinutes(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesToTime(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function nearestTimeOffsets() {
  const offsets = [];
  for (let amount = 30; amount <= 240; amount += 30) offsets.push(amount, -amount);
  return offsets;
}

function normalizeTimeKey(value) {
  const minutes = timeToMinutes(value);
  return minutes === null ? '' : minutesToTime(minutes);
}

function normalizeComparableText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function addDays(dateKey, amount) {
  if (!dateKey) return null;
  const date = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function diffDays(startKey, endKey) {
  if (!startKey || !endKey) return 1;
  const start = new Date(`${startKey}T00:00:00Z`);
  const end   = new Date(`${endKey}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 1;
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

function toDisplayDate(dateKey) {
  if (!dateKey) return '';
  const [yyyy, mm, dd] = dateKey.split('-');
  return `${dd}-${mm}-${yyyy}`;
}
