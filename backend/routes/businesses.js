// Business-scoped staff API: /api/businesses and /api/b/:businessId/…
// Every handler below runs after `authenticate` + `requireBusinessRole`, so
// `req.business` is always a business the signed-in user belongs to.
import express from 'express';
import { z } from 'zod';
import { authenticate, requireBusinessRole, MANAGER_ROLES } from '../middleware/auth.js';
import { query } from '../services/db.js';
import { sendError, validationError, notFound } from '../platform/errors.js';
import * as businesses from '../platform/businesses.js';
import * as inventory from '../platform/inventory.js';
import * as integrations from '../platform/integrations.js';
import { listAudit, recordAudit } from '../platform/audit.js';
import { SERVICE_TYPES } from '../platform/config.js';
import { localDayBounds, todayKey, addDays, isDateKey } from '../platform/time.js';
import { getNotificationSettings, upsertNotificationSettings, getBusinessSetting, setBusinessSetting } from '../services/appSettings.js';
import * as booking from '../booking/service.js';
import { operationalHistory } from '../booking/operations.js';
import { repairCalendar, calendarTarget } from '../booking/downstream.js';
import { enqueueJob, runJobNow, runDueJobs, jobHealth } from '../booking/sync/jobs.js';
import { legacyReviewReport } from '../scripts/migrate.js';
import pool from '../services/db.js';
import { mockSettings, updateMockSettings, seedMockInventory, mockPms } from '../booking/providers/mockPms.js';

const wrap = (handler) => async (req, res) => {
  try {
    const body = await handler(req, res);
    if (body !== undefined && !res.headersSent) res.json(body);
  } catch (err) {
    sendError(res, err);
  }
};
const idParam = (value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw notFound();
  return id;
};

// ── Account level ────────────────────────────────────────────────────────────
export const accountRouter = express.Router();
accountRouter.use(authenticate);
accountRouter.get('/', wrap((req) => businesses.listBusinessesForUser(req.user.id)));
accountRouter.post('/', wrap(async (req, res) => {
  const created = await businesses.createBusiness(req.user, req.body);
  res.status(201);
  return created;
}));

// ── One business ─────────────────────────────────────────────────────────────
const router = express.Router({ mergeParams: true });
const member = requireBusinessRole();                 // owner, admin or staff
const manager = requireBusinessRole(...MANAGER_ROLES); // configuration, integrations, access
router.use(authenticate);

router.get('/', member, wrap(async (req) => ({
  business: businesses.publicBusiness(req.business),
  role: req.membershipRole,
  services: await businesses.listServices(req.business.id),
  activation: await businesses.activationReview(req.business),
})));
router.patch('/', manager, wrap((req) => businesses.updateBusiness(req.business, req.body, req.actor)));
router.post('/status', manager, wrap((req) => businesses.setBusinessStatus(req.business, req.body?.status, req.actor)));
router.get('/review', manager, wrap(async (req) => {
  if (!req.business.is_legacy) return { business: null, items: [], blocking: [] };
  return legacyReviewReport(pool);
}));

router.patch('/services/:serviceType', manager, wrap(async (req) => {
  await businesses.updateService(req.business, req.params.serviceType, req.body, req.actor);
  return businesses.listServices(req.business.id);
}));

// Members
router.get('/members', manager, wrap((req) => businesses.listMembers(req.business.id)));
router.post('/members', manager, wrap((req) => businesses.upsertMember(req.business, req.body, req.actor, req.membershipRole)));
router.delete('/members/:id', manager, wrap(async (req) => {
  await businesses.removeMember(req.business, idParam(req.params.id), req.actor, req.membershipRole);
  return { success: true };
}));

// Inventory
const serviceFilter = (req) => (SERVICE_TYPES.includes(req.query.service_type) ? req.query.service_type : undefined);
router.get('/resource-types', member, wrap((req) => inventory.listTypes(req.business.id, { serviceType: serviceFilter(req) })));
router.post('/resource-types', manager, wrap(async (req, res) => { res.status(201); return inventory.createType(req.business, req.body, req.actor); }));
router.patch('/resource-types/:id', manager, wrap((req) => inventory.updateType(req.business, idParam(req.params.id), req.body, req.actor)));
router.delete('/resource-types/:id', manager, wrap(async (req) => { await inventory.archiveType(req.business, idParam(req.params.id), req.actor); return { success: true }; }));

router.get('/resources', member, wrap((req) => inventory.listResources(req.business.id, {
  serviceType: serviceFilter(req), includeArchived: req.query.include_archived === 'true' })));
router.post('/resources/preview', manager, wrap(async (req) => {
  const { type, ...preview } = await inventory.previewBatch(req.business, req.body);
  return preview;
}));
router.post('/resources/batch', manager, wrap(async (req, res) => { res.status(201); return inventory.createBatch(req.business, req.body, req.actor); }));
router.patch('/resources/:id', manager, wrap((req) => inventory.updateResource(req.business, idParam(req.params.id), req.body, req.actor)));
router.delete('/resources/:id', manager, wrap((req) => inventory.archiveResource(req.business, idParam(req.params.id), req.actor)));
router.get('/resources/:id/history', member, wrap((req) => operationalHistory(req.business.id, idParam(req.params.id))));

// Closures
const closureSchema = z.object({
  service_type: z.enum(SERVICE_TYPES).nullable().default(null),
  start_date: z.string().refine(isDateKey), end_date: z.string().refine(isDateKey), reason: z.string().trim().max(200).default(''),
}).strict().refine((value) => value.end_date >= value.start_date, 'End date must not be before the start date');
router.get('/closures', member, wrap(async (req) => (await query(
  `SELECT id, service_type, start_date::text, end_date::text, reason FROM closures WHERE business_id = $1 ORDER BY start_date`, [req.business.id])).rows));
router.post('/closures', manager, wrap(async (req, res) => {
  const data = closureSchema.parse(req.body);
  const row = (await query(
    `INSERT INTO closures (business_id, service_type, start_date, end_date, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, service_type, start_date::text, end_date::text, reason`,
    [req.business.id, data.service_type, data.start_date, data.end_date, data.reason, req.user.id])).rows[0];
  await recordAudit(null, { businessId: req.business.id, actor: req.actor, action: 'create', entity: 'closure', entityId: row.id, after: row });
  res.status(201);
  return row;
}));
router.delete('/closures/:id', manager, wrap(async (req) => {
  const removed = await query('DELETE FROM closures WHERE id = $1 AND business_id = $2 RETURNING id', [idParam(req.params.id), req.business.id]);
  if (!removed.rows.length) throw notFound();
  return { success: true };
}));

// Reservations — all through the shared booking layer
router.post('/availability', member, wrap(async (req) => {
  const availability = await booking.checkAvailability(req.business, req.body);
  const alternative = availability.selected ? null : await booking.findAlternatives(req.business, req.body).catch(() => null);
  return { ...availability, alternative };
}));
router.get('/reservations', member, wrap((req) => booking.listReservations(req.business.id, {
  service_type: serviceFilter(req), status: req.query.status || undefined, search: req.query.search || undefined,
  from: req.query.from ? new Date(req.query.from) : undefined, to: req.query.to ? new Date(req.query.to) : undefined,
  limit: req.query.limit, order: req.query.order })));
router.post('/reservations', member, wrap(async (req, res) => {
  const channel = ['phone', 'walk_in', 'staff'].includes(req.body?.channel) ? req.body.channel : 'staff';
  const result = await booking.createReservation(req.business, { ...req.body, channel, session_id: undefined }, req.actor);
  res.status(result.idempotent_replay ? 200 : 201);
  return result;
}));
router.get('/reservations/:id', member, wrap((req) => booking.getReservation(req.business, idParam(req.params.id))));
router.patch('/reservations/:id', member, wrap((req) => {
  const { changes = {}, options = {} } = req.body || {};
  // Staff have seen the new terms in the dashboard; they accept re-quotes explicitly.
  return booking.modifyReservation(req.business, idParam(req.params.id), changes, options, req.actor);
}));
router.post('/reservations/:id/cancel', member, wrap((req) => booking.cancelReservation(req.business, idParam(req.params.id), { reason: String(req.body?.reason || '') }, req.actor)));
router.post('/reservations/:id/confirm', member, wrap((req) => booking.confirmHeldReservation(req.business, idParam(req.params.id), req.actor)));
router.post('/reservations/:id/deposit', member, wrap((req) => booking.recordDeposit(req.business, idParam(req.params.id), req.body?.status, req.actor)));

// Daily operations
router.get('/operations/board', member, wrap((req) => booking.operationsBoard(req.business, { date: req.query.date, serviceType: serviceFilter(req) })));
router.post('/operations/actions', member, wrap((req) => booking.applyOperation(req.business, req.body, req.actor)));
router.post('/operations/maintenance', member, wrap(async (req, res) => { res.status(201); return booking.addMaintenance(req.business, req.body, req.actor); }));
router.delete('/operations/maintenance/:id', member, wrap((req) => booking.removeMaintenance(req.business, idParam(req.params.id), req.actor)));

// Integrations and synchronization
router.get('/integrations', manager, wrap(async (req) => ({
  connectors: integrations.listConnectors(), integrations: await integrations.listIntegrations(req.business.id),
  production_connector_available: integrations.listConnectors().some((connector) => connector.production_ready),
})));
router.post('/integrations', manager, wrap(async (req, res) => { res.status(201); return integrations.createIntegration(req.business, req.body, req.actor); }));
router.post('/integrations/:id/test', manager, wrap((req) => integrations.testIntegration(req.business, idParam(req.params.id), req.actor)));
router.post('/integrations/:id/import', manager, wrap((req) => integrations.importInventory(req.business, idParam(req.params.id), req.actor)));
router.get('/integrations/:id/mappings', manager, wrap((req) => integrations.listMappings(req.business.id, idParam(req.params.id))));
router.get('/integrations/:id/health', manager, wrap((req) => integrations.integrationHealth(req.business.id, idParam(req.params.id))));
router.post('/integrations/:id/reconcile', manager, wrap(async (req) => {
  const integration = await integrations.getIntegration(req.business.id, idParam(req.params.id));
  if (!integration) throw notFound('Integration not found.');
  const jobId = await enqueueJob(null, { businessId: req.business.id, integrationId: integration.id, kind: 'reconcile', dedupeKey: `integration:${integration.id}` });
  return (await runJobNow(jobId)) || { status: 'queued' };
}));

// Mock provider controls: simulate the remote system. Never available in production.
const mockOnly = async (req) => {
  if (process.env.NODE_ENV === 'production') throw notFound();
  const integration = await integrations.getIntegration(req.business.id, idParam(req.params.id));
  if (!integration || integration.provider_key !== 'mock') throw notFound('Mock integration not found.');
  return integration;
};
router.get('/integrations/:id/mock', manager, wrap(async (req) => {
  const integration = await mockOnly(req);
  return { settings: await mockSettings(integration.id), inventory: await mockPms.listInventory(integration.id),
    reservations: (await query('SELECT external_id, status, guest_name, party_size, starts_at, ends_at, unit_external_id, version FROM mock_pms_reservations WHERE integration_id = $1 ORDER BY id DESC LIMIT 50', [integration.id])).rows };
}));
router.patch('/integrations/:id/mock', manager, wrap(async (req) => updateMockSettings((await mockOnly(req)).id, req.body || {})));
router.post('/integrations/:id/mock/inventory', manager, wrap(async (req) => {
  const integration = await mockOnly(req);
  await seedMockInventory(integration.id, req.body?.types || []);
  return mockPms.listInventory(integration.id);
}));
router.post('/integrations/:id/mock/reservations/:externalId', manager, wrap(async (req) => {
  const integration = await mockOnly(req);
  const updated = await mockPms.update(integration.id, req.params.externalId, req.body || {});
  if (!updated) throw notFound('No such reservation in the mock system.');
  return updated;
}));

router.get('/sync/jobs', manager, wrap((req) => jobHealth(req.business.id)));
router.post('/sync/jobs/run', manager, wrap((req) => runDueJobs({ ignoreSchedule: true, businessId: req.business.id })));

// Settings, audit, calendar
router.get('/audit', manager, wrap((req) => listAudit(req.business.id, { limit: req.query.limit, entity: req.query.entity })));
const notificationSchema = z.object({
  provider: z.enum(['slack', 'teams']), webhook_url: z.string().url().or(z.literal('')), alert_email: z.string().email().or(z.literal('')),
}).strict();
router.get('/settings/notifications', manager, wrap((req) => getNotificationSettings(req.business.id, { allowEnvFallback: req.business.is_legacy })));
router.patch('/settings/notifications', manager, wrap((req) => upsertNotificationSettings(req.business.id, notificationSchema.parse(req.body), req.actor)));
router.get('/settings/calendar', manager, wrap(async (req) => {
  const target = await calendarTarget(req.business);
  return { calendar_id: await getBusinessSetting(req.business.id, 'google_calendar_id'), enabled: target.enabled,
    uses_deployment_calendar: Boolean(target.calendarId) && !(await getBusinessSetting(req.business.id, 'google_calendar_id')) };
}));
router.patch('/settings/calendar', manager, wrap(async (req) => {
  const calendarId = z.string().trim().max(200).parse(req.body?.calendar_id ?? '');
  await setBusinessSetting(req.business.id, 'google_calendar_id', calendarId);
  await recordAudit(null, { businessId: req.business.id, actor: req.actor, action: 'update', entity: 'calendar_settings', after: { calendar_id: calendarId } });
  return { calendar_id: calendarId, enabled: (await calendarTarget(req.business)).enabled };
}));
router.post('/calendar/repair', manager, wrap((req) => repairCalendar(req.business, req.body?.limit)));

// Analytics (business-local "today")
router.get('/analytics/summary', member, wrap(async (req) => {
  const today = localDayBounds(todayKey(req.business.timezone), req.business.timezone);
  const row = (await query(
    `SELECT COUNT(*) FILTER (WHERE status NOT IN ('cancelled', 'no_show') AND NOT waitlisted)::int AS total,
            COUNT(*) FILTER (WHERE status NOT IN ('cancelled', 'no_show') AND NOT waitlisted AND starts_at < $3 AND ends_at > $2)::int AS today,
            COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
            COUNT(*) FILTER (WHERE waitlisted AND status = 'pending')::int AS waitlisted
     FROM bookings WHERE business_id = $1`, [req.business.id, today.start, today.end])).rows[0];
  const byService = (await query(
    `SELECT service_type, COUNT(*)::int AS n FROM bookings WHERE business_id = $1 AND status NOT IN ('cancelled', 'no_show') AND NOT waitlisted
     GROUP BY service_type`, [req.business.id])).rows;
  return { total_bookings: row.total, today_bookings: row.today, cancellations: row.cancelled, waitlisted: row.waitlisted,
    by_service: { restaurant: 0, hotel: 0, meeting: 0, ...Object.fromEntries(byService.map((item) => [item.service_type, item.n])) } };
}));
router.get('/analytics/timeseries', member, wrap(async (req) => {
  const today = todayKey(req.business.timezone);
  const rows = (await query(
    `SELECT date::text AS date, COUNT(*)::int AS bookings FROM bookings
     WHERE business_id = $1 AND status NOT IN ('cancelled', 'no_show') AND date BETWEEN $2 AND $3 GROUP BY date ORDER BY date`,
    [req.business.id, addDays(today, -7), addDays(today, 7)])).rows;
  return rows;
}));
router.get('/analytics/recent', member, wrap((req) => booking.listReservations(req.business.id, { limit: 5 })));

router.use((req, res) => res.status(404).json({ error: 'Route not found' }));

export default router;
export { validationError };
