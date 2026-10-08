// Business-local calendar and clock arithmetic without a timezone library.
// Dates are 'YYYY-MM-DD' keys, times are 'HH:MM', instants are JS Dates (UTC).
const formatters = new Map();

function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatters.get(timeZone);
}

export function isValidTimezone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.includes('/') && timeZone !== 'UTC') return false;
  try { formatter(timeZone); return true; } catch { return false; }
}

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(instant, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(instant).map(({ type, value }) => [type, value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}

function offsetMs(utcMs, timeZone) {
  const p = zonedParts(new Date(utcMs), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

export function isDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseTime(value) {
  const match = String(value ?? '').match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

export function formatMinutes(total) {
  const minutes = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function diffDays(startKey, endKey) {
  return Math.round((Date.parse(`${endKey}T00:00:00Z`) - Date.parse(`${startKey}T00:00:00Z`)) / 86400000);
}

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const weekdayOf = (dateKey) => WEEKDAYS[new Date(`${dateKey}T00:00:00Z`).getUTCDay()];

/**
 * Local wall-clock time → instant. Returns { instant, valid }.
 * `valid` is false for a time skipped by a daylight-saving jump (it does not
 * exist on that date). A repeated time resolves to its first occurrence.
 */
export function zonedToInstant(dateKey, minutesOfDay, timeZone) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, day, 0, minutesOfDay);
  const first = wall - offsetMs(wall, timeZone);
  const candidates = [first, wall - offsetMs(first, timeZone)];
  // A candidate is right when converting it back gives the requested wall time.
  const exact = candidates.filter((ms) => {
    const p = zonedParts(new Date(ms), timeZone);
    return p.date === dateKey && p.minutes === ((minutesOfDay % 1440) + 1440) % 1440;
  });
  if (exact.length) return { instant: new Date(Math.min(...exact)), valid: true };
  return { instant: new Date(Math.max(...candidates)), valid: false };
}

export function todayKey(timeZone, now = new Date()) {
  return zonedParts(now, timeZone).date;
}

/** [start, end) instants covering one business-local calendar day. */
export function localDayBounds(dateKey, timeZone) {
  return {
    start: zonedToInstant(dateKey, 0, timeZone).instant,
    end: zonedToInstant(addDays(dateKey, 1), 0, timeZone).instant,
  };
}

export function toDateKey(value) {
  if (!value) return null;
  if (value instanceof Date) {
    // pg returns DATE columns as local-midnight Date objects.
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const text = String(value);
  const display = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  const key = display ? `${display[3]}-${display[2].padStart(2, '0')}-${display[1].padStart(2, '0')}` : text.slice(0, 10);
  return isDateKey(key) ? key : null;
}

export function displayDate(dateKey) {
  if (!dateKey) return '';
  const [yyyy, mm, dd] = dateKey.split('-');
  return `${dd}-${mm}-${yyyy}`;
}
