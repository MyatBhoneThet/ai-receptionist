// Service configuration with three levels of inheritance:
//   platform default → service settings → resource-type defaults → resource overrides
// Every level stores only the fields it sets; `resolveConfig` reports where
// each effective value came from so the dashboard can show "inherited".
import { z } from 'zod';
import { AMOUNT_PATTERN } from './money.js';
import { parseTime, WEEKDAYS } from './time.js';

export const SERVICE_TYPES = ['hotel', 'restaurant', 'meeting'];

const money = z.string().trim().regex(AMOUNT_PATTERN, 'Enter an amount such as 1500 or 1500.50');
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');
const tags = z.array(z.string().trim().min(1).max(60)).max(40);
const minutes = (max) => z.number().int().min(0).max(max);

const period = z.object({ open: clock, close: clock }).strict()
  .refine((p) => p.open !== p.close, 'Opening and closing time cannot be identical');
// close <= open means the period runs past midnight into the next day.
const operatingHours = z.object(Object.fromEntries(WEEKDAYS.map((day) => [day, z.array(period).max(4)]))).partial().strict().nullable();

const deposit = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('fixed'), amount: money }).strict(),
  z.object({ type: z.literal('per_guest'), amount: money }).strict(),
  z.object({ type: z.literal('percent'), percent: z.number().min(1).max(100) }).strict(),
]);

const layout = z.object({ name: z.string().trim().min(1).max(60), capacity: z.number().int().min(1).max(5000) }).strict();

const FIELDS = {
  hotel: {
    max_guests: z.number().int().min(1).max(50),
    bed_configuration: z.string().trim().max(120),
    amenities: tags,
    base_rate: money,                 // per night
    check_in_time: clock,
    check_out_time: clock,
    min_stay_nights: z.number().int().min(1).max(365),
    floor: z.number().int().min(-10).max(300).nullable(),
    deposit,
    booking_fee: money,
  },
  meeting: {
    layouts: z.array(layout).min(1).max(12),   // capacity by layout
    equipment: tags,
    amenities: tags,
    rate_unit: z.enum(['hourly', 'daily']),
    base_rate: money,
    min_duration_minutes: z.number().int().min(15).max(1440),
    increment_minutes: z.number().int().min(5).max(720),
    setup_buffer_minutes: minutes(480),
    cleanup_buffer_minutes: minutes(480),
    operating_hours: operatingHours,
    deposit,
    booking_fee: money,
  },
  restaurant: {
    seating_capacity: z.number().int().min(1).max(500),
    seating_area: z.string().trim().min(1).max(60),
    default_duration_minutes: z.number().int().min(15).max(720),
    turnover_buffer_minutes: minutes(240),
    min_spend: money,                 // spending commitment, not a charge
    deposit,
    booking_fee: money,
    operating_hours: operatingHours,
  },
};

export const PLATFORM_DEFAULTS = {
  hotel: {
    max_guests: 2, bed_configuration: '', amenities: [], base_rate: '0', check_in_time: '14:00',
    check_out_time: '11:00', min_stay_nights: 1, floor: null, deposit: { type: 'none' }, booking_fee: '0',
  },
  meeting: {
    layouts: [{ name: 'Standard', capacity: 8 }], equipment: [], amenities: [], rate_unit: 'hourly', base_rate: '0',
    min_duration_minutes: 30, increment_minutes: 30, setup_buffer_minutes: 0, cleanup_buffer_minutes: 0,
    operating_hours: null, deposit: { type: 'none' }, booking_fee: '0',
  },
  restaurant: {
    seating_capacity: 4, seating_area: 'indoor', default_duration_minutes: 90, turnover_buffer_minutes: 15,
    min_spend: '0', deposit: { type: 'none' }, booking_fee: '0', operating_hours: null,
  },
};

// Labels are service-specific on purpose ("Maximum guests" vs "Seating capacity").
export const FIELD_LABELS = {
  hotel: {
    max_guests: 'Maximum guests', bed_configuration: 'Bed configuration', amenities: 'Amenities',
    base_rate: 'Base nightly rate', check_in_time: 'Check-in time', check_out_time: 'Check-out time',
    min_stay_nights: 'Minimum stay (nights)', floor: 'Floor', deposit: 'Deposit policy', booking_fee: 'Booking fee',
  },
  meeting: {
    layouts: 'Capacity by layout', equipment: 'Equipment', amenities: 'Amenities', rate_unit: 'Rate unit',
    base_rate: 'Base rate', min_duration_minutes: 'Minimum booking duration (minutes)',
    increment_minutes: 'Booking increments (minutes)', setup_buffer_minutes: 'Setup buffer (minutes)',
    cleanup_buffer_minutes: 'Cleanup buffer (minutes)', operating_hours: 'Operating hours',
    deposit: 'Deposit policy', booking_fee: 'Booking fee',
  },
  restaurant: {
    seating_capacity: 'Seating capacity', seating_area: 'Seating area',
    default_duration_minutes: 'Default reservation duration (minutes)',
    turnover_buffer_minutes: 'Turnover / cleaning buffer (minutes)', min_spend: 'Minimum spend per reservation',
    deposit: 'Deposit policy', booking_fee: 'Booking fee', operating_hours: 'Operating hours',
  },
};

const partialSchemas = Object.fromEntries(SERVICE_TYPES.map((service) => [service, z.object(FIELDS[service]).partial().strict()]));
const fullSchemas = Object.fromEntries(SERVICE_TYPES.map((service) => [service, z.object(FIELDS[service]).strict()]));

/** Validate one level's partial settings; unknown keys are rejected. */
export function parseLevel(serviceType, input) {
  return partialSchemas[serviceType].parse(input ?? {});
}

export function resolveConfig(serviceType, serviceSettings = {}, typeDefaults = {}, resourceOverrides = {}) {
  const levels = [
    ['platform', PLATFORM_DEFAULTS[serviceType]], ['service', serviceSettings || {}],
    ['type', typeDefaults || {}], ['resource', resourceOverrides || {}],
  ];
  const values = {};
  const sources = {};
  for (const field of Object.keys(FIELDS[serviceType])) {
    for (const [level, data] of levels) {
      if (data[field] !== undefined) { values[field] = data[field]; sources[field] = level; }
    }
  }
  return { values, sources };
}

/** Cross-field rules that only make sense on the fully resolved configuration. */
export function validateResolved(serviceType, values) {
  const parsed = fullSchemas[serviceType].safeParse(values);
  if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  const problems = [];
  if (serviceType === 'hotel' && parseTime(values.check_out_time) > parseTime(values.check_in_time)) {
    problems.push('Check-out time must not be later than check-in time, otherwise back-to-back stays would overlap.');
  }
  if (serviceType === 'meeting') {
    const names = values.layouts.map((item) => item.name.toLowerCase());
    if (new Set(names).size !== names.length) problems.push('Layout names must be unique.');
    if (values.min_duration_minutes % values.increment_minutes !== 0) {
      problems.push('Minimum booking duration must be a multiple of the booking increment.');
    }
  }
  return problems;
}

/** Largest party a resource can take (meeting rooms: for the given layout). */
export function capacityOf(serviceType, values, layoutName) {
  if (serviceType === 'hotel') return values.max_guests;
  if (serviceType === 'restaurant') return values.seating_capacity;
  if (layoutName) {
    const match = values.layouts.find((item) => item.name.toLowerCase() === String(layoutName).toLowerCase());
    return match ? match.capacity : 0;
  }
  return Math.max(...values.layouts.map((item) => item.capacity));
}

export function fieldCatalog(serviceType) {
  return Object.keys(FIELDS[serviceType]).map((key) => ({ key, label: FIELD_LABELS[serviceType][key] }));
}
