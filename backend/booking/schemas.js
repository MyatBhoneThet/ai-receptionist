// Request contracts for the shared booking layer. Every caller — AI chat,
// staff dashboard, walk-ins, waitlist — goes through these.
import { z } from 'zod';
import { SERVICE_TYPES } from '../platform/config.js';
import { toDateKey, parseTime, formatMinutes } from '../platform/time.js';

// Blank strings from forms and chat mean "not provided".
const blank = (value) => value == null || value === '';
const dateShape = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a real calendar date');
const toDate = (value) => (blank(value) ? undefined : toDateKey(value) ?? value);
const dateKey = z.preprocess(toDate, dateShape);
const optionalDate = z.preprocess(toDate, dateShape.optional());

const clockShape = z.string().regex(/^\d{2}:\d{2}$/, 'Use 24-hour HH:MM');
const toClock = (value) => {
  if (blank(value)) return undefined;
  const minutes = parseTime(value);
  return minutes === null ? value : formatMinutes(minutes);
};
const clock = z.preprocess(toClock, clockShape);
const optionalClock = z.preprocess(toClock, clockShape.optional());

const idShape = z.number().int().positive();
const toId = (value) => (blank(value) ? undefined : Number(value));
const positiveId = z.preprocess(toId, idShape);
const optionalId = z.preprocess(toId, idShape.optional());
const optionalText = (max) => z.preprocess((value) => (blank(value) ? undefined : value), z.string().trim().max(max).optional());

const people = z.preprocess((value) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value),
  z.number().int().min(1).max(5000));

const requirement = {
  service_type: z.enum(SERVICE_TYPES),
  date: dateKey,                       // hotel: check-in date (property-local)
  end_date: optionalDate,               // hotel: check-out date
  start_time: optionalClock,
  end_time: optionalClock,
  people,
  resource_id: optionalId,
  resource_type_id: optionalId,
  layout: optionalText(60),
  preference: optionalText(120),       // free text such as "suite" or "patio"
};

export const availabilitySchema = z.object({
  ...requirement,
  exclude_booking_id: optionalId,
  immediate: z.boolean().optional(),
}).strict();

const phone = z.string().trim().refine((value) => {
  const digits = value.replace(/\D/g, '');
  return /^\+?[\d ()-]+$/.test(value) && digits.length >= 7 && digits.length <= 15;
}, 'Enter a valid phone number');

export const customerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: phone.optional(),
  email: z.string().trim().email().optional(),
}).strict();

export const createSchema = z.object({
  ...requirement,
  idempotency_key: z.string().trim().min(8).max(200),
  customer: customerSchema,
  notes: z.string().max(2000).default(''),
  channel: z.enum(['chat', 'staff', 'phone', 'walk_in']).default('staff'),
  session_id: z.string().max(200).optional(),
  // Hash of the quote the customer was shown. When it no longer matches, the
  // caller must show the new terms and ask again.
  accepted_quote_hash: z.string().optional(),
  waitlist_if_unavailable: z.boolean().default(false),
  immediate: z.boolean().default(false),     // walk-in: occupy now, must be operationally ready
  hold: z.boolean().default(false),          // staff: create as an unconfirmed hold
}).strict();

export const modifySchema = z.object({
  date: dateKey, end_date: dateKey, start_time: clock, end_time: clock, people,
  resource_id: positiveId.nullable(), resource_type_id: positiveId, layout: z.string().trim().max(60),
  reservation_name: z.string().trim().min(1).max(120),
  contact_phone: phone, contact_email: z.string().trim().email().or(z.literal('')),
  notes: z.string().max(2000),
}).partial().strict();

export const modifyOptionsSchema = z.object({
  accepted_quote_hash: z.string().optional(),
  accept_requote: z.boolean().default(false),
  allow_reassign: z.boolean().default(false),
  idempotency_key: z.string().trim().min(8).max(200).optional(),
}).strict();

export const SCHEDULE_FIELDS = ['date', 'end_date', 'start_time', 'end_time', 'people', 'resource_id', 'resource_type_id', 'layout'];
