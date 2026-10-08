// Resource types (defaults) and individual physical resources (overrides).
import { z } from 'zod';
import { query, withTransaction } from '../services/db.js';
import { BookingError, notFound, validationError } from './errors.js';
import { parseLevel, resolveConfig, validateResolved, capacityOf, SERVICE_TYPES, fieldCatalog } from './config.js';
import { recordAudit } from './audit.js';
import { HOLDING_STATUSES, getService } from './businesses.js';

const code = z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N}][\p{L}\p{N} ._/-]*$/u, 'Use letters, digits, spaces, dots, slashes or hyphens');

const typeCreateSchema = z.object({
  service_type: z.enum(SERVICE_TYPES),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  code_prefix: z.string().trim().max(10).default(''),
  defaults: z.record(z.any()).default({}),
}).strict();

const typeUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
  code_prefix: z.string().trim().max(10),
  defaults: z.record(z.any()),
  is_active: z.boolean(),
  acknowledge_conflicts: z.boolean(),
}).partial().strict();

// Quantity is only a convenience for generating N distinct physical records.
export const batchSchema = z.object({
  resource_type_id: z.number().int().positive(),
  quantity: z.number().int().min(1).max(500).optional(),
  prefix: z.string().trim().max(10).default(''),
  start_number: z.number().int().min(0).max(99999).default(1),
  pad: z.number().int().min(1).max(6).default(2),
  codes: z.array(code).min(1).max(500).optional(),
}).strict().refine((value) => Boolean(value.quantity) !== Boolean(value.codes), 'Provide either a quantity or an explicit list of codes');

const resourceUpdateSchema = z.object({
  code,
  name: z.string().trim().max(120),
  overrides: z.record(z.any()),
  reset: z.array(z.string()).max(40),            // override keys to drop → inherit again
  is_active: z.boolean(),
  resource_type_id: z.number().int().positive(),
  acknowledge_conflicts: z.boolean(),
}).partial().strict();

function shapeType(row, serviceSettings) {
  return {
    id: Number(row.id), service_type: row.service_type, name: row.name, description: row.description,
    code_prefix: row.code_prefix, defaults: row.defaults || {}, managed_by: row.managed_by,
    is_active: row.is_active, archived_at: row.archived_at,
    resource_count: row.resource_count === undefined ? undefined : Number(row.resource_count),
    effective: resolveConfig(row.service_type, serviceSettings, row.defaults || {}),
    fields: fieldCatalog(row.service_type),
  };
}

function shapeResource(row, serviceSettings, typeDefaults) {
  const effective = resolveConfig(row.service_type, serviceSettings, typeDefaults, row.overrides || {});
  return {
    id: Number(row.id), service_type: row.service_type, resource_type_id: Number(row.resource_type_id),
    resource_type_name: row.type_name, code: row.code, name: row.name, overrides: row.overrides || {},
    managed_by: row.managed_by, is_active: row.is_active, archived_at: row.archived_at,
    operational_status: row.operational_status, operational_note: row.operational_note,
    operational_updated_at: row.operational_updated_at,
    legacy: row.legacy_table ? { table: row.legacy_table, id: row.legacy_id } : null,
    effective, capacity: capacityOf(row.service_type, effective.values),
  };
}

async function serviceSettingsMap(businessId, db) {
  const run = db ? db.query.bind(db) : query;
  const rows = (await run('SELECT service_type, settings FROM business_services WHERE business_id = $1', [businessId])).rows;
  return Object.fromEntries(rows.map((row) => [row.service_type, row.settings || {}]));
}

export async function listTypes(businessId, { serviceType, includeArchived = false } = {}) {
  const settings = await serviceSettingsMap(businessId);
  const rows = (await query(
    `SELECT t.*, (SELECT COUNT(*) FROM resources r WHERE r.resource_type_id = t.id AND r.archived_at IS NULL) AS resource_count
     FROM resource_types t
     WHERE t.business_id = $1 AND ($2::text IS NULL OR t.service_type = $2) AND ($3 OR t.archived_at IS NULL)
     ORDER BY t.service_type, lower(t.name)`, [businessId, serviceType || null, includeArchived])).rows;
  return rows.map((row) => shapeType(row, settings[row.service_type]));
}

export async function listResources(businessId, { serviceType, includeArchived = false } = {}) {
  const settings = await serviceSettingsMap(businessId);
  const rows = (await query(
    `SELECT r.*, t.name AS type_name, t.defaults AS type_defaults
     FROM resources r JOIN resource_types t ON t.id = r.resource_type_id
     WHERE r.business_id = $1 AND ($2::text IS NULL OR r.service_type = $2) AND ($3 OR r.archived_at IS NULL)
     ORDER BY r.service_type, lower(t.name), r.code`, [businessId, serviceType || null, includeArchived])).rows;
  return rows.map((row) => shapeResource(row, settings[row.service_type], row.type_defaults || {}));
}

function assertInternallyManaged(row, what) {
  if (row.managed_by === 'external') {
    throw new BookingError('unsupported_operation',
      `This ${what} is owned by the connected reservation system. Change its rules there; only the local display name can be edited here.`);
  }
}

async function assertInternalService(businessId, serviceType, db) {
  const service = await getService(businessId, serviceType, db);
  if (!service) throw notFound('Unknown service.');
  if (service.booking_source !== 'internal') {
    throw new BookingError('unsupported_operation',
      'This service is managed by an external system. Import and map its inventory from Integrations instead of creating it here.');
  }
  return service;
}

function assertResolved(serviceType, serviceSettings, typeDefaults, overrides = {}) {
  const problems = validateResolved(serviceType, resolveConfig(serviceType, serviceSettings, typeDefaults, overrides).values);
  if (problems.length) throw validationError(problems[0], { problems });
}

export async function createType(business, input, actor) {
  const data = typeCreateSchema.parse(input);
  const defaults = parseLevel(data.service_type, data.defaults);
  return withTransaction(async (db) => {
    const service = await assertInternalService(business.id, data.service_type, db);
    assertResolved(data.service_type, service.settings, defaults);
    try {
      const row = (await db.query(
        `INSERT INTO resource_types (business_id, service_type, name, description, code_prefix, defaults)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *`,
        [business.id, data.service_type, data.name, data.description, data.code_prefix, JSON.stringify(defaults)])).rows[0];
      await recordAudit(db, { businessId: business.id, actor, action: 'create', entity: 'resource_type', entityId: row.id,
        after: { service_type: row.service_type, name: row.name, ...defaults } });
      return shapeType(row, service.settings);
    } catch (err) {
      if (err.code === '23505') throw validationError(`A ${data.service_type} type named "${data.name}" already exists.`, { field: 'name' });
      throw err;
    }
  });
}

/** Upcoming committed reservations that a configuration change would no longer satisfy. */
async function capacityConflicts(db, businessId, resources) {
  if (!resources.length) return [];
  const rows = (await db.query(
    `SELECT id, resource_id, people, layout, reservation_name, starts_at FROM bookings
     WHERE business_id = $1 AND resource_id = ANY($2::bigint[]) AND status = ANY($3::text[])
       AND waitlisted = FALSE AND ends_at >= NOW()`,
    [businessId, resources.map((item) => item.id), HOLDING_STATUSES])).rows;
  const byId = new Map(resources.map((item) => [String(item.id), item]));
  return rows.filter((row) => {
    const resource = byId.get(String(row.resource_id));
    return Number(row.people || 1) > capacityOf(resource.service_type, resource.values, row.layout);
  }).map((row) => ({ booking_id: row.id, resource_id: Number(row.resource_id), people: row.people,
    reservation_name: row.reservation_name, starts_at: row.starts_at, reason: 'party_exceeds_new_capacity' }));
}

function requireAcknowledgement(conflicts, acknowledged, message) {
  if (conflicts.length && !acknowledged) {
    throw new BookingError('config_conflict', message, { affected_bookings: conflicts, acknowledge_with: 'acknowledge_conflicts' });
  }
}

export async function updateType(business, typeId, input, actor) {
  const data = typeUpdateSchema.parse(input);
  return withTransaction(async (db) => {
    const current = (await db.query(
      'SELECT * FROM resource_types WHERE id = $1 AND business_id = $2 AND archived_at IS NULL FOR UPDATE', [typeId, business.id])).rows[0];
    if (!current) throw notFound('Resource type not found.');
    const policyChange = data.defaults !== undefined || data.is_active !== undefined || data.code_prefix !== undefined;
    if (policyChange) assertInternallyManaged(current, 'type');
    const service = await getService(business.id, current.service_type, db);
    const defaults = data.defaults !== undefined ? parseLevel(current.service_type, data.defaults) : current.defaults;

    if (data.defaults !== undefined) {
      assertResolved(current.service_type, service.settings, defaults);
      const resources = (await db.query(
        'SELECT id, service_type, overrides FROM resources WHERE resource_type_id = $1 AND archived_at IS NULL', [typeId])).rows;
      for (const resource of resources) assertResolved(current.service_type, service.settings, defaults, resource.overrides);
      const conflicts = await capacityConflicts(db, business.id, resources.map((resource) => ({
        id: resource.id, service_type: current.service_type,
        values: resolveConfig(current.service_type, service.settings, defaults, resource.overrides).values })));
      requireAcknowledgement(conflicts, data.acknowledge_conflicts,
        'This change would leave upcoming reservations above the new capacity. Existing reservations keep the terms they were booked on; confirm to continue.');
    }
    try {
      const row = (await db.query(
        `UPDATE resource_types SET name = $2, description = $3, code_prefix = $4, defaults = $5::jsonb, is_active = $6
         WHERE id = $1 RETURNING *`,
        [typeId, data.name ?? current.name, data.description ?? current.description, data.code_prefix ?? current.code_prefix,
          JSON.stringify(defaults), data.is_active ?? current.is_active])).rows[0];
      await recordAudit(db, { businessId: business.id, actor, action: 'update', entity: 'resource_type', entityId: row.id,
        before: { name: current.name, is_active: current.is_active, ...current.defaults },
        after: { name: row.name, is_active: row.is_active, ...row.defaults } });
      return shapeType(row, service.settings);
    } catch (err) {
      if (err.code === '23505') throw validationError(`A type named "${data.name}" already exists.`, { field: 'name' });
      throw err;
    }
  });
}

export async function archiveType(business, typeId, actor) {
  return withTransaction(async (db) => {
    const current = (await db.query(
      'SELECT * FROM resource_types WHERE id = $1 AND business_id = $2 AND archived_at IS NULL FOR UPDATE', [typeId, business.id])).rows[0];
    if (!current) throw notFound('Resource type not found.');
    assertInternallyManaged(current, 'type');
    const inUse = (await db.query('SELECT 1 FROM resources WHERE resource_type_id = $1 AND archived_at IS NULL LIMIT 1', [typeId])).rows.length;
    if (inUse) throw new BookingError('config_conflict', 'Archive or move this type\'s rooms/tables first.');
    await db.query('UPDATE resource_types SET archived_at = NOW(), is_active = FALSE WHERE id = $1', [typeId]);
    await recordAudit(db, { businessId: business.id, actor, action: 'archive', entity: 'resource_type', entityId: typeId, before: { name: current.name } });
  });
}

function generateCodes(data, type) {
  if (data.codes) return data.codes.map((item) => item.trim());
  const prefix = data.prefix || type.code_prefix || '';
  return Array.from({ length: data.quantity }, (_, index) => `${prefix}${String(data.start_number + index).padStart(data.pad, '0')}`);
}

/** Codes a batch would create and why any of them cannot be used. Read-only. */
export async function previewBatch(business, input, db) {
  const data = batchSchema.parse(input);
  const run = db ? db.query.bind(db) : query;
  const type = (await run(
    'SELECT * FROM resource_types WHERE id = $1 AND business_id = $2 AND archived_at IS NULL', [data.resource_type_id, business.id])).rows[0];
  if (!type) throw notFound('Resource type not found.');
  const codes = generateCodes(data, type);
  const seen = new Set();
  const duplicatesInBatch = new Set();
  for (const item of codes) {
    const key = item.toLowerCase();
    if (seen.has(key)) duplicatesInBatch.add(key);
    seen.add(key);
  }
  const existing = new Set((await run(
    `SELECT lower(code) AS code FROM resources
     WHERE business_id = $1 AND service_type = $2 AND archived_at IS NULL AND lower(code) = ANY($3::text[])`,
    [business.id, type.service_type, [...seen]])).rows.map((row) => row.code));
  const items = codes.map((item) => {
    const key = item.toLowerCase();
    const problem = !code.safeParse(item).success ? 'invalid_code'
      : duplicatesInBatch.has(key) ? 'duplicate_in_batch' : existing.has(key) ? 'already_exists' : null;
    return { code: item, problem };
  });
  return { type, service_type: type.service_type, resource_type_id: Number(type.id), items,
    valid: items.every((item) => !item.problem), count: items.length };
}

/** Create N distinct physical resources atomically: all of them or none. */
export async function createBatch(business, input, actor) {
  return withTransaction(async (db) => {
    const preview = await previewBatch(business, input, db);
    assertInternallyManaged(preview.type, 'type');
    await assertInternalService(business.id, preview.service_type, db);
    if (!preview.valid) {
      throw validationError('Some codes cannot be created. Nothing was saved.', { items: preview.items.filter((item) => item.problem) });
    }
    try {
      const inserted = (await db.query(
        `INSERT INTO resources (business_id, service_type, resource_type_id, code)
         SELECT $1, $2, $3, c FROM unnest($4::text[]) WITH ORDINALITY AS t(c, n) ORDER BY n RETURNING id, code`,
        [business.id, preview.service_type, preview.resource_type_id, preview.items.map((item) => item.code)])).rows;
      await recordAudit(db, { businessId: business.id, actor, action: 'create_batch', entity: 'resource',
        after: { resource_type: preview.type.name, count: inserted.length, codes: inserted.map((row) => row.code).join(', ') } });
      return inserted.map((row) => ({ id: Number(row.id), code: row.code }));
    } catch (err) {
      // A concurrent batch created one of the codes after the preview.
      if (err.code === '23505') throw validationError('One of these codes was just created by someone else. Nothing was saved.');
      throw err;
    }
  });
}

export async function updateResource(business, resourceId, input, actor) {
  const data = resourceUpdateSchema.parse(input);
  return withTransaction(async (db) => {
    const current = (await db.query(
      'SELECT * FROM resources WHERE id = $1 AND business_id = $2 AND archived_at IS NULL FOR UPDATE', [resourceId, business.id])).rows[0];
    if (!current) throw notFound('Room or table not found.');
    const policyChange = ['code', 'overrides', 'reset', 'is_active', 'resource_type_id'].some((key) => data[key] !== undefined);
    if (policyChange) assertInternallyManaged(current, 'room or table');

    const typeId = data.resource_type_id ?? Number(current.resource_type_id);
    const type = (await db.query(
      'SELECT * FROM resource_types WHERE id = $1 AND business_id = $2 AND service_type = $3 AND archived_at IS NULL',
      [typeId, business.id, current.service_type])).rows[0];
    if (!type) throw validationError('That type does not belong to this service.');
    const service = await getService(business.id, current.service_type, db);

    let overrides = { ...(current.overrides || {}) };
    if (data.overrides !== undefined) overrides = { ...overrides, ...parseLevel(current.service_type, data.overrides) };
    for (const key of data.reset || []) delete overrides[key];   // "reset to default"
    overrides = parseLevel(current.service_type, overrides);
    assertResolved(current.service_type, service.settings, type.defaults, overrides);

    const nextActive = data.is_active ?? current.is_active;
    const values = resolveConfig(current.service_type, service.settings, type.defaults, overrides).values;
    const conflicts = await capacityConflicts(db, business.id, [{ id: current.id, service_type: current.service_type, values }]);
    if (current.is_active && !nextActive) {
      const upcoming = (await db.query(
        `SELECT id, reservation_name, starts_at FROM bookings WHERE business_id = $1 AND resource_id = $2
           AND status = ANY($3::text[]) AND waitlisted = FALSE AND ends_at >= NOW()`, [business.id, current.id, HOLDING_STATUSES])).rows;
      conflicts.push(...upcoming.map((row) => ({ booking_id: row.id, resource_id: Number(current.id),
        reservation_name: row.reservation_name, starts_at: row.starts_at, reason: 'resource_deactivated' })));
    }
    requireAcknowledgement(conflicts, data.acknowledge_conflicts,
      'This change affects upcoming reservations. They are not altered automatically; confirm to continue and then review them.');

    try {
      const row = (await db.query(
        `UPDATE resources SET code = $2, name = $3, overrides = $4::jsonb, is_active = $5, resource_type_id = $6 WHERE id = $1 RETURNING *`,
        [current.id, data.code ?? current.code, data.name ?? current.name, JSON.stringify(overrides), nextActive, typeId])).rows[0];
      await recordAudit(db, { businessId: business.id, actor, action: 'update', entity: 'resource', entityId: row.id,
        before: { code: current.code, name: current.name, is_active: current.is_active, ...current.overrides },
        after: { code: row.code, name: row.name, is_active: row.is_active, ...row.overrides } });
      return { ...shapeResource({ ...row, type_name: type.name }, service.settings, type.defaults), acknowledged_conflicts: conflicts };
    } catch (err) {
      if (err.code === '23505') throw validationError(`"${data.code}" is already used in this service.`, { field: 'code' });
      throw err;
    }
  });
}

/** Remove a resource from sale. History is never deleted. */
export async function archiveResource(business, resourceId, actor) {
  return withTransaction(async (db) => {
    const current = (await db.query(
      'SELECT * FROM resources WHERE id = $1 AND business_id = $2 AND archived_at IS NULL FOR UPDATE', [resourceId, business.id])).rows[0];
    if (!current) throw notFound('Room or table not found.');
    assertInternallyManaged(current, 'room or table');
    const upcoming = (await db.query(
      `SELECT id FROM bookings WHERE business_id = $1 AND resource_id = $2 AND status = ANY($3::text[])
         AND waitlisted = FALSE AND ends_at >= NOW()`, [business.id, current.id, HOLDING_STATUSES])).rows;
    if (upcoming.length) {
      throw new BookingError('config_conflict',
        `${current.code} has ${upcoming.length} active or upcoming reservation(s). Reassign or cancel them before archiving.`,
        { booking_ids: upcoming.map((row) => row.id) });
    }
    const hasHistory = (await db.query(
      `SELECT 1 FROM bookings WHERE resource_id = $1 UNION ALL SELECT 1 FROM operational_events WHERE resource_id = $1 LIMIT 1`, [current.id])).rows.length;
    if (hasHistory) {
      await db.query('UPDATE resources SET archived_at = NOW(), is_active = FALSE WHERE id = $1', [current.id]);
    } else {
      await db.query('DELETE FROM resources WHERE id = $1', [current.id]);
    }
    await recordAudit(db, { businessId: business.id, actor, action: hasHistory ? 'archive' : 'delete', entity: 'resource',
      entityId: current.id, before: { code: current.code, service_type: current.service_type } });
    return { archived: Boolean(hasHistory), deleted: !hasHistory };
  });
}
