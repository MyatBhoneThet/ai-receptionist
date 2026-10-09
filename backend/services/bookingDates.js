const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
  april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const ORDINALS = [
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth',
  'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth',
  'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth',
  'twenty first', 'twenty second', 'twenty third', 'twenty fourth', 'twenty fifth',
  'twenty sixth', 'twenty seventh', 'twenty eighth', 'twenty ninth', 'thirtieth', 'thirty first',
];
const DAY_WORDS = Object.fromEntries(ORDINALS.map((word, index) => [word, index + 1]));
const DAY_PATTERN = `(?:${[...ORDINALS].sort((a, b) => b.length - a.length).join('|')}|\\d{1,2}(?:st|nd|rd|th)?)`;
const MONTH_PATTERN = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const YEAR_PATTERN = '(?:\\s*,?\\s*(this year|next year|\\d{4}))?';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function dateKey(year, month, day) {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const candidate = new Date(0);
  candidate.setUTCFullYear(year, month - 1, day);
  candidate.setUTCHours(0, 0, 0, 0);
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function bookingDateKey(value) {
  if (typeof value !== 'string') return null;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return dateKey(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const display = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  return display ? dateKey(Number(display[3]), Number(display[2]), Number(display[1])) : null;
}

export function displayBookingDate(value) {
  const key = bookingDateKey(value);
  if (!key) return '';
  const [year, month, day] = key.split('-');
  return `${day}-${month}-${year}`;
}

export function calendarToday(now = new Date(), timeZone = process.env.CALENDAR_TIMEZONE || 'Asia/Bangkok') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.day}-${values.month}-${values.year}`;
}

export function addBookingDays(value, days) {
  const key = bookingDateKey(value);
  if (!key || !Number.isInteger(days)) return '';
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return displayBookingDate(date.toISOString().slice(0, 10));
}

export function bookingStayDays(start, end) {
  const startKey = bookingDateKey(start);
  const endKey = bookingDateKey(end);
  if (!startKey || !endKey) return null;
  const days = (Date.parse(`${endKey}T00:00:00Z`) - Date.parse(`${startKey}T00:00:00Z`)) / 86400000;
  return days > 0 ? days : null;
}

export function hasBookingDateExpression(message) {
  const text = String(message || '').toLowerCase();
  return /\b(date|today|tomorrow|day after|check.?in|check.?out|arrival|departure)\b/.test(text)
    || /\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/.test(text)
    || new RegExp(`\\b(?:${MONTH_PATTERN}|${WEEKDAYS.join('|')})\\b`).test(text)
    || /\b\d{1,2}(?:st|nd|rd|th)\b|\b(?:this|next) month\b/.test(text);
}

// Parse calendar dates without JS's ambiguous string-date parser. Ignore negated
// alternatives, so "day after tomorrow, not tomorrow" retains the requested day.
export function resolveNaturalBookingDate(message, today = calendarToday()) {
  const text = String(message || '').toLowerCase().replace(/([a-z])-([a-z])/g, '$1 $2');
  const todayKey = bookingDateKey(today);
  if (!todayKey) return { date: '', status: 'invalid' };
  const [year, month, currentDay] = todayKey.split('-').map(Number);
  const candidates = [];
  const addMatches = (pattern, resolve) => {
    for (const match of text.matchAll(pattern)) {
      if (/\b(?:not|rather than|instead of)\s+(?:on\s+)?$/.test(text.slice(0, match.index))) continue;
      candidates.push({ index: match.index, length: match[0].length, value: resolve(match) });
    }
  };
  const resolveYear = (value) => value === 'next year' ? year + 1 : /^\d{4}$/.test(value || '') ? Number(value) : year;
  const resolveDay = (value) => DAY_WORDS[value] || Number(value.replace(/(?:st|nd|rd|th)$/, ''));

  addMatches(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})\b/g, (match) => displayBookingDate(match[0]));
  addMatches(new RegExp(`\\b(${DAY_PATTERN})\\s+(?:of\\s+)?(${MONTH_PATTERN})${YEAR_PATTERN}\\b`, 'g'),
    (match) => displayBookingDate(dateKey(resolveYear(match[3]), MONTHS[match[2]], resolveDay(match[1])) || ''));
  addMatches(new RegExp(`\\b(${MONTH_PATTERN})\\s+(${DAY_PATTERN})${YEAR_PATTERN}\\b`, 'g'),
    (match) => displayBookingDate(dateKey(resolveYear(match[3]), MONTHS[match[1]], resolveDay(match[2])) || ''));
  addMatches(/\b(?:day after tomorrow|tomorrow|today|in \d{1,3} days?|\d{1,3} days? from now)\b/g, (match) => {
    const offset = match[0] === 'day after tomorrow' ? 2 : match[0] === 'tomorrow' ? 1 : match[0] === 'today' ? 0 : Number(match[0].match(/\d+/)[0]);
    return addBookingDays(today, offset);
  });
  addMatches(new RegExp(`\\b(?:(this|next)\\s+week\\s+(?:on\\s+)?(${WEEKDAYS.join('|')})|(${WEEKDAYS.join('|')})\\s+(this|next)\\s+week)\\b`, 'g'), (match) => {
    const weekday = new Date(`${todayKey}T00:00:00Z`).getUTCDay();
    const weekStart = -((weekday + 6) % 7); // Calendar weeks begin Monday.
    const target = WEEKDAYS.indexOf(match[2] || match[3]);
    return addBookingDays(today, weekStart + ((target + 6) % 7) + ((match[1] || match[4]) === 'next' ? 7 : 0));
  });
  addMatches(new RegExp(`\\b(?:(this|next)\\s+)?(${WEEKDAYS.join('|')})\\b`, 'g'), (match) => {
    const weekday = new Date(`${todayKey}T00:00:00Z`).getUTCDay();
    let offset = (WEEKDAYS.indexOf(match[2]) - weekday + 7) % 7;
    // "Next Tuesday" means the next occurrence of Tuesday, not an
    // additional week after it. "This Friday" on Friday means today.
    if (offset === 0 && match[1] !== 'this') offset = 7;
    return addBookingDays(today, offset);
  });
  addMatches(/\b(this|next)\s+month\s+(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\b|\b(\d{1,2})\s+(this|next)\s+month\b/g, (match) => {
    let targetMonth = month + ((match[1] || match[4]) === 'next' ? 1 : 0);
    const targetYear = year + (targetMonth > 12 ? 1 : 0);
    if (targetMonth > 12) targetMonth -= 12;
    return displayBookingDate(dateKey(targetYear, targetMonth, Number(match[2] || match[3])) || '');
  });
  const ordinal = /\b(?:(this|next)\s+month\s+(?:on\s+)?)?(\d{1,2})(st|nd|rd|th)(?:\s+(this|next)\s+month)?\b/g;
  addMatches(ordinal, (match) => {
    // An ordinal followed by a named month belongs to the full named-date match.
    if (new RegExp(`^\\s+(?:of\\s+)?(?:${MONTH_PATTERN})\\b`).test(text.slice(match.index + match[0].length))) return null;
    const hint = match[1] || match[4];
    let targetMonth = month + (hint === 'next' || (!hint && Number(match[2]) < currentDay) ? 1 : 0);
    const targetYear = year + (targetMonth > 12 ? 1 : 0);
    if (targetMonth > 12) targetMonth -= 12;
    return displayBookingDate(dateKey(targetYear, targetMonth, Number(match[2])) || '');
  });

  // Later positive corrections win; discard overlapping shorter matches.
  const eligible = candidates.filter((candidate) => candidate.value !== null
    && !candidates.some((other) => other !== candidate && other.index <= candidate.index
      && other.index + other.length >= candidate.index + candidate.length && other.length > candidate.length));
  eligible.sort((a, b) => a.index - b.index || b.length - a.length);
  if (!eligible.length) return { date: '', status: hasBookingDateExpression(text) ? 'unresolved' : 'absent' };
  const last = eligible.at(-1);
  const beforeLast = text.slice(0, last.index);
  const corrected = eligible.length > 1 && (
    /\b(?:actually|instead|rather|make it|sorry|i mean|change(?: it)? to|move(?: it)? to|reschedule(?: it)? to)[,:]?\s*(?:on\s+)?$/.test(beforeLast)
    || (/\b(?:change|move|reschedule)\b/.test(text)
      && /\bfrom\s*$/.test(text.slice(0, eligible[0].index)) && /\bto\s*$/.test(beforeLast))
  );
  if (!last.value || (eligible.some((candidate) => !candidate.value) && !corrected)) {
    return { date: '', status: 'invalid' };
  }
  const distinct = new Set(eligible.map((candidate) => candidate.value));
  // A weekday alongside a matching calendar date is redundant, not a
  // conflict. Other multiple dates require clarification unless corrected.
  if (distinct.size > 1 && !corrected) return { date: '', status: 'ambiguous' };
  return { date: last.value, status: 'resolved' };
}

export function extractNaturalBookingDate(message, today = calendarToday()) {
  return resolveNaturalBookingDate(message, today).date;
}
