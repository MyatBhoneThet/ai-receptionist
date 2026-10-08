import { z } from 'zod';
import { query, withTransaction } from '../services/db.js';
import { BookingError, notFound, validationError } from './errors.js';
import { isCurrencyCode } from './money.js';
import { isValidTimezone } from './time.js';
import { parseLevel, resolveConfig, validateResolved, SERVICE_TYPES, PLATFORM_DEFAULTS, fieldCatalog } from './config.js';
import { recordAudit } from './audit.js';

export const HOLDING_STATUSES = ['pending', 'confirmed', 'modified', 'checked_in'];
const BLOCKING_REVIEW = ['missing_resource_assignment', 'resource_service_mismatch', 'double_booked', 'invalid_time_range', 'missing_schedule'];

const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/,
  'Use 3–64 lowercase letters, digits or hyphens');
const serviceInput = z.object({
  service_type: z.enum(SERVICE_TYPES),
  enabled: z.boolean(),
  booking_source: z.enum(['internal', 'external']).default('internal'),
}).strict();

export const createBusinessSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug,
  timezone: z.string().refine(isValidTimezone, 'Unknown IANA timezone'),
  currency: z.string().trim().toUpperCase().refine(isCurrencyCode, 'Unknown ISO 4217 currency'),
  contact_email: z.string().trim().email().or(z.literal('')).default(''),
  contact_phone: z.string().trim().max(40).default(''),
  address: z.string().trim().max(300).default(''),
  services: z.array(serviceInput).min(1).refine(
    (list) => new Set(list.map((item) => item.service_type)).size === list.length, 'Each service may appear once'),
}).strict();

export const updateBusinessSchema = z.object({
  name: z.string().trim().min(1).max(120),
  timezone: z.string().refine(isValidTimezone, 'Unknown IANA timezone'),
  currency: z.string().trim().toUpperCase().refine(isCurrencyCode, 'Unknown ISO 4217 currency'),
  contact_email: z.string().trim().email().or(z.literal('')),
  contact_phone: z.string().trim().max(40),
  address: z.string().trim().max(300),
}).partial().strict();

export const updateServiceSchema = z.object({
  enabled: z.boolean(),
  booking_source: z.enum(['internal', 'external']),
  integration_id: z.number().int().positive().nullable(),
  settings: z.record(z.any()),
}).partial().strict();

function publicBusiness(row) {
  if (!row) return null;
  return {
    id: Number(row.id), name: row.name, slug: row.slug, timezone: row.timezone, currency: row.currency,
    currency_confirmed: row.currency_confirmed, contact_email: row.contact_email || '', contact_phone: row.contact_phone || '',
    address: row.address || '', status: row.status, is_legacy: row.is_legacy, activated_at: row.activated_at,
  };
}

export async function createBusiness(user, input) {
  const data = createBusinessSchema.parse(input);
  return withTransaction(async (db) => {
    let business;
    try {
      business = (await db.query(
        `INSERT INTO businesses (name, slug, timezone, currency, currency_confirmed, contact_email, contact_phone, address)
         VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7) RETURNING *`,
        [data.name, data.slug, data.timezone, data.currency, data.contact_email, data.contact_phone, data.address])).rows[0];
    } catch (err) {
      if (err.code === '23505') throw validationError('That public booking identifier is already taken.', { field: 'slug' });
      throw err;
    }
    await db.query(`INSERT INTO business_memberships (business_id, user_id, role) VALUES ($1, $2, 'owner')`, [business.id, user.id]);
    for (const service of SERVICE_TYPES) {
      const chosen = data.services.find((item) => item.service_type === service);
      // External services start disabled until an integration is connected and mapped.
      await db.query(
        `INSERT INTO business_services (business_id, service_type, enabled, booking_source) VALUES ($1, $2, $3, $4)`,
        [business.id, service, Boolean(chosen?.enabled), chosen?.booking_source || 'internal']);
    }
    await recordAudit(db, { businessId: business.id, actor: { email: user.email, userId: user.id },
      action: 'create', entity: 'business', entityId: business.id, after: publicBusiness(business) });
    return publicBusiness(business);
  });
}

export async function listBusinessesForUser(userId) {
  const result = await query(
    `SELECT b.*, m.role AS membership_role FROM businesses b
     JOIN business_memberships m ON m.business_id = b.id WHERE m.user_id = $1 ORDER BY b.name`, [userId]);
  return result.rows.map((row) => ({ ...publicBusiness(row), role: row.membership_role }));
}

export async function getBusiness(businessId, db) {
  const run = db ? db.query.bind(db) : query;
  return (await run('SELECT * FROM businesses WHERE id = $1', [businessId])).rows[0] || null;
}

export async function getBusinessBySlug(slugValue) {
  return (await query('SELECT * FROM businesses WHERE slug = $1', [String(slugValue || '').toLowerCase()])).rows[0] || null;
}

/** The business a guest request is for. A slug is required once more than
 * one business accepts bookings; it is never inferred from a booking ID. */
export async function resolvePublicBusiness(slugValue) {
  if (slugValue) return getBusinessBySlug(slugValue);
  const fallback = process.env.DEFAULT_BUSINESS_SLUG;
  if (fallback) return getBusinessBySlug(fallback);
  const active = await query(`SELECT * FROM businesses WHERE status = 'active' ORDER BY id LIMIT 2`);
  return active.rows.length === 1 ? active.rows[0] : null;
}

export async function updateBusiness(business, input, actor) {
  const data = updateBusinessSchema.parse(input);
  if (data.currency && data.currency !== business.currency && business.currency_confirmed) {
    const priced = await query(`SELECT 1 FROM bookings WHERE business_id = $1 AND quote IS NOT NULL LIMIT 1`, [business.id]);
    if (priced.rows.length) {
      throw new BookingError('config_conflict', 'Currency cannot be changed after reservations have been priced in it.');
    }
  }
  if (data.timezone && data.timezone !== business.timezone) {
    const scheduled = await query(`SELECT 1 FROM bookings WHERE business_id = $1 AND starts_at IS NOT NULL LIMIT 1`, [business.id]);
    if (scheduled.rows.length) {
      throw new BookingError('config_conflict', 'Timezone cannot be changed once reservations exist, because their local times would shift.');
    }
  }
  const next = { ...publicBusiness(business), ...data };
  const updated = (await query(
    `UPDATE businesses SET name = $2, timezone = $3, currency = $4, currency_confirmed = $5,
            contact_email = $6, contact_phone = $7, address = $8 WHERE id = $1 RETURNING *`,
    [business.id, next.name, next.timezone, next.currency, business.currency_confirmed || Boolean(data.currency),
      next.contact_email, next.contact_phone, next.address])).rows[0];
  await recordAudit(null, { businessId: business.id, actor, action: 'update', entity: 'business', entityId: business.id,
    before: publicBusiness(business), after: publicBusiness(updated) });
  return publicBusiness(updated);
}

export async function listServices(businessId, db) {
  const run = db ? db.query.bind(db) : query;
  const rows = (await run(
    `SELECT s.*, i.name AS integration_name, i.provider_key, i.environment AS integration_environment,
            i.status AS integration_status, i.last_reconciled_at
     FROM business_services s LEFT JOIN integrations i ON i.id = s.integration_id
     WHERE s.business_id = $1 ORDER BY s.service_type`, [businessId])).rows;
  return rows.map((row) => ({
    service_type: row.service_type, enabled: row.enabled, booking_source: row.booking_source,
    integration_id: row.integration_id ? Number(row.integration_id) : null,
    integration: row.integration_id ? { id: Number(row.integration_id), name: row.integration_name, provider_key: row.provider_key,
      environment: row.integration_environment, status: row.integration_status, last_reconciled_at: row.last_reconciled_at } : null,
    settings: row.settings || {},
    effective: resolveConfig(row.service_type, row.settings || {}),
    platform_defaults: PLATFORM_DEFAULTS[row.service_type],
    fields: fieldCatalog(row.service_type),
  }));
}

export async function getService(businessId, serviceType, db) {
  const run = db ? db.query.bind(db) : query;
  return (await run('SELECT * FROM business_services WHERE business_id = $1 AND service_type = $2', [businessId, serviceType])).rows[0] || null;
}

/** Reservations and provider commands that a source switch would strand. */
export async function sourceSwitchBlockers(businessId, serviceType, db) {
  const run = db ? db.query.bind(db) : query;
  const reservations = Number((await run(
    `SELECT COUNT(*) AS n FROM bookings
     WHERE business_id = $1 AND service_type = $2
       AND (status = ANY($3::text[]) OR status = 'awaiting_confirmation')
       AND (ends_at IS NULL OR ends_at >= NOW())`, [businessId, serviceType, HOLDING_STATUSES])).rows[0].n);
  const commands = Number((await run(
    `SELECT COUNT(*) AS n FROM booking_commands
     WHERE business_id = $1 AND service_type = $2 AND status IN ('in_progress', 'unknown')`, [businessId, serviceType])).rows[0].n);
  return { reservations, commands };
}

export async function updateService(business, serviceType, input, actor) {
  if (!SERVICE_TYPES.includes(serviceType)) throw notFound('Unknown service.');
  const data = updateServiceSchema.parse(input);
  return withTransaction(async (db) => {
    const current = (await db.query(
      'SELECT * FROM business_services WHERE business_id = $1 AND service_type = $2 FOR UPDATE', [business.id, serviceType])).rows[0];
    if (!current) throw notFound('Unknown service.');
    const next = { ...current };

    if (data.settings !== undefined) {
      next.settings = parseLevel(serviceType, data.settings);
      const problems = validateResolved(serviceType, resolveConfig(serviceType, next.settings).values);
      if (problems.length) throw validationError(problems[0], { problems });
      // The new defaults must also be valid for every type and room/table that inherits them.
      const inheritors = (await db.query(
        `SELECT t.name AS type_name, t.defaults, r.code, r.overrides FROM resource_types t
         LEFT JOIN resources r ON r.resource_type_id = t.id AND r.archived_at IS NULL
         WHERE t.business_id = $1 AND t.service_type = $2 AND t.archived_at IS NULL`, [business.id, serviceType])).rows;
      for (const item of inheritors) {
        const issues = validateResolved(serviceType, resolveConfig(serviceType, next.settings, item.defaults, item.overrides || {}).values);
        if (issues.length) {
          throw validationError(`${item.code ? `${item.code} (${item.type_name})` : item.type_name}: ${issues[0]}`, { problems: issues });
        }
      }
    }
    if (data.booking_source !== undefined && data.booking_source !== current.booking_source) {
      // A plain toggle must never strand reservations held by the other source.
      const blockers = await sourceSwitchBlockers(business.id, serviceType, db);
      if (blockers.reservations || blockers.commands) {
        throw new BookingError('config_conflict',
          `The booking source cannot be switched while ${blockers.reservations} active or upcoming reservation(s) and ` +
          `${blockers.commands} unresolved provider request(s) exist. Switching later requires a controlled migration.`, blockers);
      }
      next.booking_source = data.booking_source;
      if (data.booking_source === 'internal') next.integration_id = null;
    }
    if (data.integration_id !== undefined) {
      if (data.integration_id !== null) {
        if (next.booking_source !== 'external') throw validationError('Only an externally sourced service can use an integration.');
        const integration = (await db.query('SELECT id FROM integrations WHERE id = $1 AND business_id = $2',
          [data.integration_id, business.id])).rows[0];
        if (!integration) throw notFound('Integration not found.');
      }
      if (String(data.integration_id ?? '') !== String(current.integration_id ?? '')) {
        const blockers = await sourceSwitchBlockers(business.id, serviceType, db);
        if (current.integration_id && (blockers.reservations || blockers.commands)) {
          throw new BookingError('config_conflict', 'The connected system cannot be replaced while it holds active reservations.', blockers);
        }
      }
      next.integration_id = data.integration_id;
    }
    if (data.enabled !== undefined) next.enabled = data.enabled;

    const updated = (await db.query(
      `UPDATE business_services SET enabled = $3, booking_source = $4, integration_id = $5, settings = $6::jsonb
       WHERE business_id = $1 AND service_type = $2 RETURNING *`,
      [business.id, serviceType, next.enabled, next.booking_source, next.integration_id, JSON.stringify(next.settings || {})])).rows[0];
    await recordAudit(db, { businessId: business.id, actor, action: 'update', entity: 'service_settings',
      before: { service_type: serviceType, enabled: current.enabled, booking_source: current.booking_source, ...current.settings },
      after: { service_type: serviceType, enabled: updated.enabled, booking_source: updated.booking_source, ...updated.settings } });
    return updated;
  });
}

/** Everything that must be true before customers can book. */
export async function activationReview(business) {
  const services = await listServices(business.id);
  const businessBlockers = [];
  if (!business.currency || !business.currency_confirmed) {
    businessBlockers.push({ code: 'currency_unconfirmed', message: 'Confirm the currency used for prices.' });
  }
  if (!isValidTimezone(business.timezone)) businessBlockers.push({ code: 'timezone_invalid', message: 'Set a valid timezone.' });
  if (!services.some((service) => service.enabled)) {
    businessBlockers.push({ code: 'no_services', message: 'Enable at least one service.' });
  }

  const review = [];
  for (const service of services.filter((item) => item.enabled)) {
    const blockers = [];
    if (service.booking_source === 'internal') {
      const active = Number((await query(
        `SELECT COUNT(*) AS n FROM resources WHERE business_id = $1 AND service_type = $2 AND is_active AND archived_at IS NULL`,
        [business.id, service.service_type])).rows[0].n);
      if (!active) blockers.push({ code: 'no_inventory', message: 'Add at least one active room or table.' });
      const ambiguous = (await query(
        `SELECT id, review_reason, reservation_name, date FROM bookings
         WHERE business_id = $1 AND service_type = $2 AND review_reason = ANY($3::text[])
           AND status = ANY($4::text[]) AND waitlisted = FALSE AND (ends_at IS NULL OR ends_at >= NOW())
         ORDER BY id`, [business.id, service.service_type, BLOCKING_REVIEW, HOLDING_STATUSES])).rows;
      if (ambiguous.length) {
        blockers.push({ code: 'legacy_review', message: `${ambiguous.length} migrated reservation(s) need a room/table decision.`,
          bookings: ambiguous.map((row) => ({ id: row.id, reason: row.review_reason, reservation_name: row.reservation_name })) });
      }
    } else {
      const integration = service.integration;
      if (!integration) blockers.push({ code: 'no_integration', message: 'Connect the external reservation system.' });
      else {
        if (integration.status !== 'connected') blockers.push({ code: 'integration_not_connected', message: 'Test the connection successfully.' });
        if (integration.environment !== 'production') {
          // A mock or sandbox connection can never serve real customers.
          const allowMock = process.env.NODE_ENV !== 'production' && process.env.ALLOW_MOCK_PROVIDER_BOOKING === 'true';
          if (!allowMock) {
            blockers.push({ code: 'no_production_connector', message:
              'This service is connected to a MOCK provider. Customer booking stays off until a real connector is implemented and validated.' });
          }
        }
        const mapped = Number((await query(
          `SELECT COUNT(*) AS n FROM external_mappings WHERE integration_id = $1 AND service_type = $2
             AND (resource_type_id IS NOT NULL OR resource_id IS NOT NULL)`, [integration.id, service.service_type])).rows[0].n);
        if (!mapped) blockers.push({ code: 'no_mapping', message: 'Import and map the external inventory.' });
      }
    }
    review.push({ service_type: service.service_type, booking_source: service.booking_source, blockers, ready: blockers.length === 0 });
  }
  return {
    business_blockers: businessBlockers, services: review,
    can_activate: businessBlockers.length === 0 && review.some((item) => item.ready),
    bookable_services: businessBlockers.length ? [] : review.filter((item) => item.ready).map((item) => item.service_type),
  };
}

export async function setBusinessStatus(business, status, actor) {
  if (!['active', 'paused'].includes(status)) throw validationError('Status must be active or paused.');
  if (status === 'active') {
    const review = await activationReview(business);
    if (!review.can_activate) {
      throw new BookingError('activation_blocked', 'Customer booking cannot be activated yet.', review);
    }
  }
  const updated = (await query(
    `UPDATE businesses SET status = $2, activated_at = CASE WHEN $2 = 'active' THEN COALESCE(activated_at, NOW()) ELSE activated_at END
     WHERE id = $1 RETURNING *`, [business.id, status])).rows[0];
  await recordAudit(null, { businessId: business.id, actor, action: 'status_change', entity: 'business', entityId: business.id,
    before: { status: business.status }, after: { status } });
  return publicBusiness(updated);
}

/** Services a guest may book right now. Enforced in code, never by the model. */
export async function bookableServices(business) {
  if (business.status !== 'active') return [];
  return (await activationReview(business)).bookable_services;
}

// ── Memberships ─────────────────────────────────────────────────────────────
export async function listMembers(businessId) {
  return (await query(
    `SELECT m.id, m.role, m.created_at, u.id AS user_id, u.email, u.name
     FROM business_memberships m JOIN users u ON u.id = m.user_id WHERE m.business_id = $1 ORDER BY m.created_at`, [businessId])).rows;
}

const memberSchema = z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(['owner', 'admin', 'staff']) }).strict();

export async function upsertMember(business, input, actor, actorRole) {
  const data = memberSchema.parse(input);
  if (data.role === 'owner' && actorRole !== 'owner') throw new BookingError('forbidden', 'Only an owner can grant ownership.');
  return withTransaction(async (db) => {
    const user = (await db.query('SELECT id, email FROM users WHERE email = $1', [data.email])).rows[0];
    if (!user) throw validationError('No account exists for that email. Ask them to register first.', { field: 'email' });
    const existing = (await db.query(
      'SELECT * FROM business_memberships WHERE business_id = $1 AND user_id = $2 FOR UPDATE', [business.id, user.id])).rows[0];
    if (existing?.role === 'owner' && data.role !== 'owner') await assertAnotherOwner(db, business.id, user.id, actorRole);
    const saved = (await db.query(
      `INSERT INTO business_memberships (business_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (business_id, user_id) DO UPDATE SET role = EXCLUDED.role RETURNING *`, [business.id, user.id, data.role])).rows[0];
    await recordAudit(db, { businessId: business.id, actor, action: existing ? 'update' : 'create', entity: 'membership',
      entityId: saved.id, before: existing ? { email: user.email, role: existing.role } : {}, after: { email: user.email, role: data.role } });
    return saved;
  });
}

async function assertAnotherOwner(db, businessId, userId, actorRole) {
  if (actorRole !== 'owner') throw new BookingError('forbidden', 'Only an owner can change an owner.');
  const owners = (await db.query(
    `SELECT user_id FROM business_memberships WHERE business_id = $1 AND role = 'owner' FOR UPDATE`, [businessId])).rows;
  if (!owners.some((row) => row.user_id !== userId)) throw validationError('A business must keep at least one owner.');
}

export async function removeMember(business, membershipId, actor, actorRole) {
  return withTransaction(async (db) => {
    const member = (await db.query(
      `SELECT m.*, u.email FROM business_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.id = $1 AND m.business_id = $2 FOR UPDATE OF m`, [membershipId, business.id])).rows[0];
    if (!member) throw notFound('Member not found.');
    if (member.role === 'owner') await assertAnotherOwner(db, business.id, member.user_id, actorRole);
    await db.query('DELETE FROM business_memberships WHERE id = $1', [member.id]);
    await recordAudit(db, { businessId: business.id, actor, action: 'delete', entity: 'membership', entityId: member.id,
      before: { email: member.email, role: member.role } });
  });
}

export { publicBusiness };
