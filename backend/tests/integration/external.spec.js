// External-system mode against the MOCK provider. The mock keeps its own
// authoritative state (mock_pms_* tables), so these tests can change the
// "remote" side behind the platform's back.
import request from 'supertest';
import { resetDb, closeDb, makeBusiness, idem, bookingRow } from '../helpers/db.js';
import { loadApp } from '../helpers/app.js';
import { query } from '../../services/db.js';
import { updateService, getBusiness, activationReview, setBusinessStatus } from '../../platform/businesses.js';
import { createIntegration, testIntegration, importInventory, listMappings } from '../../platform/integrations.js';
import { seedMockInventory, updateMockSettings, mockPms, signMockWebhook } from '../../booking/providers/mockPms.js';

const ctx = await loadApp();
const { app, tokenFor } = ctx;
const booking = await import('../../booking/service.js');
const jobs = await import('../../booking/sync/jobs.js');
const { updateResource, updateType, createType } = await import('../../platform/inventory.js');

async function expectError(promise, code) {
  const err = await promise.then(() => null, (caught) => caught);
  expect(err?.code).toBe(code);
  return err;
}

let biz;
let integration;
let webhookSecret;
const stay = (date = '2027-03-10', end_date = '2027-03-12', people = 2) => ({ service_type: 'hotel', date, end_date, people });
const remote = async () => (await query('SELECT * FROM mock_pms_reservations ORDER BY id')).rows;
const local = async () => (await query('SELECT * FROM bookings ORDER BY id')).rows;
const create = (request_, extra = {}) => booking.createReservation(biz.business,
  { idempotency_key: idem(), customer: { name: 'Avery Stone', phone: '0812345678' }, channel: 'staff', ...request_, ...extra }, biz.actor);

beforeEach(async () => {
  await resetDb();
  ctx.resetMocks();
  process.env.ALLOW_MOCK_PROVIDER_BOOKING = 'true';
  // The hotel is sourced externally; the restaurant stays internal.
  biz = await makeBusiness({ slug: 'grand', activate: false,
    restaurant: { types: [{ name: 'Table', defaults: { seating_capacity: 4 }, codes: ['T1'] }] } });
  const created = await createIntegration(biz.business, { provider_key: 'mock', name: 'Front Desk PMS (mock)' }, biz.actor);
  webhookSecret = created.webhook_secret_once;
  integration = created;
  await seedMockInventory(integration.id, [
    { service_type: 'hotel', external_id: 'DLX', name: 'Deluxe', capacity: 2, rate: '2500', units: [{ external_id: 'U-301', code: '301' }, { external_id: 'U-302', code: '302' }] },
  ]);
  await updateService(biz.business, 'hotel', { enabled: true, booking_source: 'external', integration_id: integration.id }, biz.actor);
  await testIntegration(biz.business, integration.id, biz.actor);
  await importInventory(biz.business, integration.id, biz.actor);
  await setBusinessStatus(biz.business, 'active', biz.actor);
  biz.business = await getBusiness(biz.business.id);
});
afterAll(async () => { delete process.env.ALLOW_MOCK_PROVIDER_BOOKING; await closeDb(); });

describe('configuration and capabilities', () => {
  it('labels the mock clearly, declares its capabilities, and never exposes credentials', async () => {
    const withSecret = await createIntegration(biz.business, { provider_key: 'mock', name: 'Second', credentials: { api_key: 'super-secret-key' } }, biz.actor);
    const listed = await request(app).get(`/api/b/${biz.business.id}/integrations`).set('Authorization', `Bearer ${tokenFor(biz.owner)}`);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toMatch(/super-secret-key|credentials_enc|webhook_secret/);
    const stored = (await query('SELECT credentials_enc FROM integrations WHERE id = $1', [withSecret.id])).rows[0].credentials_enc;
    expect(stored).not.toContain('super-secret-key');
    expect(listed.body.production_connector_available).toBe(false);
    const mine = listed.body.integrations.find((item) => item.id === integration.id);
    expect(mine).toMatchObject({ is_mock: true, environment: 'mock', production_ready: false, status: 'connected', has_credentials: false });
    expect(mine.provider_label).toMatch(/not a real reservation system/i);
    expect(mine.capabilities.services).toMatchObject({ hotel: { supported: true, inventory_model: 'room_type' }, restaurant: { supported: false } });
    expect(mine.capabilities).toMatchObject({ idempotent_create: false, operational_updates: ['check_in', 'check_out'] });
    await expectError(createIntegration(biz.business, { provider_key: 'opera', name: 'Invented vendor' }, biz.actor), 'validation');
  });

  it('keeps customer booking off for a mock connection unless explicitly allowed for development', async () => {
    delete process.env.ALLOW_MOCK_PROVIDER_BOOKING;
    const review = await activationReview(biz.business);
    const hotel = review.services.find((service) => service.service_type === 'hotel');
    expect(hotel.ready).toBe(false);
    expect(hotel.blockers.map((blocker) => blocker.code)).toContain('no_production_connector');
    expect(review.bookable_services).toEqual(['restaurant']);
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_MOCK_PROVIDER_BOOKING = 'true';
    expect((await activationReview(biz.business)).bookable_services).toEqual(['restaurant']);
    process.env.NODE_ENV = 'test';
  });

  it('imports provider inventory as read-only mirrors', async () => {
    const mappings = await listMappings(biz.business.id, integration.id);
    expect(mappings.map((row) => [row.kind, row.external_id, row.resource_type_name || row.resource_code])).toEqual(
      [['resource_type', 'DLX', 'Deluxe'], ['resource', 'U-301', '301'], ['resource', 'U-302', '302']]);
    const type = mappings.find((row) => row.kind === 'resource_type');
    const unit = mappings.find((row) => row.kind === 'resource');
    await expectError(updateType(biz.business, type.resource_type_id, { defaults: { base_rate: '1' } }, biz.actor), 'unsupported_operation');
    await expectError(updateResource(biz.business, unit.resource_id, { overrides: { max_guests: 9 } }, biz.actor), 'unsupported_operation');
    await expectError(createType(biz.business, { service_type: 'hotel', name: 'Local invention' }, biz.actor), 'unsupported_operation');
    // A local display name is allowed and changes nothing about availability or price.
    await updateResource(biz.business, unit.resource_id, { name: 'Garden view' }, biz.actor);
    const availability = await booking.checkAvailability(biz.business, stay());
    expect(availability.selected.quote.total).toBe('5000.00');
    // Re-importing is idempotent.
    expect(await importInventory(biz.business, integration.id, biz.actor)).toMatchObject({ types_created: 0, resources_created: 0 });
  });

  it('blocks a source switch that would strand reservations', async () => {
    await create(stay());
    const err = await expectError(updateService(biz.business, 'hotel', { booking_source: 'internal' }, biz.actor), 'config_conflict');
    expect(err.details.reservations).toBe(1);
    expect(err.message).toMatch(/controlled migration/);
    // The internally managed restaurant is protected the same way.
    await booking.createReservation(biz.business, { service_type: 'restaurant', date: '2027-03-10', start_time: '19:00', people: 2,
      idempotency_key: idem(), customer: { name: 'Diner' }, channel: 'phone' }, biz.actor);
    await expectError(updateService(biz.business, 'restaurant', { booking_source: 'external', integration_id: integration.id }, biz.actor), 'config_conflict');
  });
});

describe('booking through the provider', () => {
  it('asks the authoritative system for availability and confirms only after its acknowledgement', async () => {
    const availability = await booking.checkAvailability(biz.business, stay());
    expect(availability).toMatchObject({ source: 'external', available: 1 });
    expect(availability.freshness).toMatchObject({ authoritative: true, cached: false });
    expect(availability.provider).toMatchObject({ is_mock: true });
    // Only a room TYPE is offered: no physical room is promised.
    expect(availability.selected).toMatchObject({ resource: null, resource_type: { name: 'Deluxe' } });

    const { reservation } = await create(stay(), { channel: 'chat', accepted_quote_hash: availability.selected.quote.hash });
    expect(reservation).toMatchObject({ status: 'confirmed', source: 'external', sync_status: 'synced', resource: null, total_amount: '5000' });
    expect(reservation.resource_type.name).toBe('Deluxe');
    expect(reservation.external_reservation_id).toMatch(/^MOCK-/);
    expect(reservation.correlation_id).toBeTruthy();
    const [pms] = await remote();
    expect(pms).toMatchObject({ external_id: reservation.external_reservation_id, status: 'confirmed', correlation_id: reservation.correlation_id });
    expect((await query('SELECT status, provider FROM booking_commands')).rows).toEqual([{ status: 'succeeded', provider: 'mock' }]);
  });

  it('records a physical room only once the provider assigns one', async () => {
    const { reservation } = await create(stay());
    expect(reservation.resource).toBeNull();
    // The front desk assigns room 302 directly in the PMS.
    await mockPms.update(integration.id, reservation.external_reservation_id, { unit_external_id: 'U-302' });
    await booking.externalBooking.reconcile(biz.business, integration.id);
    const updated = await booking.getReservation(biz.business, reservation.id);
    expect(updated.resource).toMatchObject({ code: '302' });
    expect(updated.status).toBe('confirmed');
  });

  it('reports the provider being down honestly and never falls back to an internal booking', async () => {
    await updateMockSettings(integration.id, { faults: { outage: true } });
    const check = await expectError(booking.checkAvailability(biz.business, stay()), 'provider_unavailable');
    expect(check.message).toMatch(/not responding/);
    await expectError(create(stay()), 'provider_unavailable');
    expect(await local()).toHaveLength(0);
    expect(await remote()).toHaveLength(0);
    expect(ctx.mockNotify).not.toHaveBeenCalled();
    expect((await query('SELECT status FROM booking_commands')).rows).toEqual([{ status: 'failed' }]);
    // Rate limiting is likewise surfaced, not papered over.
    await updateMockSettings(integration.id, { faults: { outage: false, rate_limit: 1 } });
    const limited = await expectError(booking.checkAvailability(biz.business, stay()), 'provider_unavailable');
    expect(limited.details.kind).toBe('rate_limited');
    expect((await booking.checkAvailability(biz.business, stay())).available).toBe(1);
  });

  it('does not create a duplicate when the provider accepts a booking but the response times out', async () => {
    await updateMockSettings(integration.id, { lookup_by_correlation: true, faults: { timeout_after_accept: 1 } });
    // Make the immediate follow-up lookup fail too, so the outcome is truly unknown.
    const originalFind = mockPms.findByCorrelation;
    mockPms.findByCorrelation = async () => { throw new Error('still unreachable'); };
    const key = idem('timeout');
    let first;
    try {
      first = await create(stay(), { idempotency_key: key });
    } finally {
      mockPms.findByCorrelation = originalFind;
    }
    // The provider DID create it…
    expect(await remote()).toHaveLength(1);
    // …but we do not know that yet, so nothing is presented as confirmed.
    expect(first.reservation).toMatchObject({ status: 'awaiting_confirmation', display_status: 'awaiting_confirmation', sync_status: 'unknown' });
    expect(first.reservation.attention_reason).toMatch(/did not answer in time/);
    expect(ctx.mockNotify).not.toHaveBeenCalled();
    expect((await query('SELECT status FROM booking_commands')).rows).toEqual([{ status: 'unknown' }]);
    expect((await query(`SELECT kind, status FROM sync_jobs WHERE kind = 'resolve_command'`)).rows).toEqual([{ kind: 'resolve_command', status: 'queued' }]);

    // The customer (or a double-click) retries the same request: it is looked up, not resubmitted.
    const retry = await create(stay(), { idempotency_key: key });
    expect(retry.idempotent_replay).toBe(true);
    expect(retry.reservation.id).toBe(first.reservation.id);
    expect(retry.reservation).toMatchObject({ status: 'confirmed', sync_status: 'synced', attention_reason: null });
    expect(await remote()).toHaveLength(1);
    expect(await local()).toHaveLength(1);

    // The durable job then finds nothing left to do, and nothing is duplicated.
    await jobs.runDueJobs({ ignoreSchedule: true });
    expect(await remote()).toHaveLength(1);
    expect(await local()).toHaveLength(1);
    expect((await query('SELECT status FROM booking_commands')).rows).toEqual([{ status: 'succeeded' }]);
  });

  it('settles an unknown outcome in the background and notifies the customer exactly once', async () => {
    await updateMockSettings(integration.id, { faults: { timeout_after_accept: 1 } });
    const originalFind = mockPms.findByCorrelation;
    mockPms.findByCorrelation = async () => { throw new Error('still unreachable'); };
    let first;
    try { first = await create(stay()); } finally { mockPms.findByCorrelation = originalFind; }
    expect(first.reservation.status).toBe('awaiting_confirmation');

    const run = await jobs.runDueJobs({ ignoreSchedule: true });
    expect(run.find((job) => job.status === 'succeeded')).toBeTruthy();
    expect((await booking.getReservation(biz.business, first.reservation.id))).toMatchObject({ status: 'confirmed', sync_status: 'synced' });
    expect(ctx.mockNotify.mock.calls.map(([call]) => call.type)).toEqual(['confirm']);
    await jobs.runDueJobs({ ignoreSchedule: true });
    expect(ctx.mockNotify).toHaveBeenCalledTimes(1);
    expect(await remote()).toHaveLength(1);
  });

  it('asks staff to step in when the provider has no record of an unknown request', async () => {
    await updateMockSettings(integration.id, { faults: { timeout_after_accept: 1 } });
    const originalFind = mockPms.findByCorrelation;
    mockPms.findByCorrelation = async () => null;     // lookups succeed but find nothing
    let first;
    try {
      first = await create(stay());
      await query('DELETE FROM mock_pms_reservations');   // the remote side really has nothing
      for (let attempt = 0; attempt < 5; attempt += 1) await jobs.runDueJobs({ ignoreSchedule: true });
    } finally { mockPms.findByCorrelation = originalFind; }
    const row = await booking.getReservation(biz.business, first.reservation.id);
    expect(row).toMatchObject({ status: 'awaiting_confirmation', sync_status: 'attention', display_status: 'awaiting_confirmation' });
    expect(row.attention_reason).toMatch(/has no record of this request/);
    // It was never resubmitted automatically.
    expect(await remote()).toHaveLength(0);
    const board = await booking.operationsBoard(biz.business, { date: '2027-03-10' });
    expect(board.attention.map((item) => item.code)).toContain('provider_attention');
    // Staff can now withdraw the request locally.
    expect((await booking.cancelReservation(biz.business, first.reservation.id, {}, biz.actor)).reservation.status).toBe('cancelled');
  });

  it('routes modifications and cancellations through the provider and keeps the original on failure', async () => {
    const { reservation } = await create(stay());
    const other = await create(stay('2027-03-12', '2027-03-14'), { customer: { name: 'Second Guest' } });
    await create(stay('2027-03-12', '2027-03-14'), { customer: { name: 'Third Guest' } });

    // Extending into nights the provider has sold out is rejected there; nothing changes here.
    const before = await bookingRow(reservation.id);
    const rejected = await expectError(booking.modifyReservation(biz.business, reservation.id, { end_date: '2027-03-13' }, {}, biz.actor), 'conflict');
    expect(rejected.details.unchanged).toBe(true);
    expect(await bookingRow(reservation.id)).toEqual(before);

    await updateMockSettings(integration.id, { faults: { outage: true } });
    await expectError(booking.modifyReservation(biz.business, reservation.id, { date: '2027-03-09' }, {}, biz.actor), 'provider_unavailable');
    await expectError(booking.cancelReservation(biz.business, other.reservation.id, {}, biz.actor), 'provider_unavailable');
    expect(await bookingRow(reservation.id)).toEqual(before);
    expect((await bookingRow(other.reservation.id)).status).toBe('confirmed');
    await updateMockSettings(integration.id, { faults: { outage: false } });

    const moved = await booking.modifyReservation(biz.business, reservation.id, { date: '2027-03-09' }, {}, biz.actor);
    expect(moved.reservation).toMatchObject({ date: '2027-03-09', end_date: '2027-03-11', sync_status: 'synced' });
    expect((await mockPms.get(integration.id, reservation.external_reservation_id)).starts_at.toISOString()).toBe('2027-03-09T07:00:00.000Z');

    const cancelled = await booking.cancelReservation(biz.business, other.reservation.id, {}, biz.actor);
    expect(cancelled.reservation.status).toBe('cancelled');
    expect((await mockPms.get(integration.id, other.reservation.external_reservation_id)).status).toBe('cancelled');
  });

  it('sends supported operational updates through the provider and refuses unsupported ones', async () => {
    const { reservation } = await create(stay());
    const checkedIn = await booking.applyOperation(biz.business, { action: 'check_in', booking_id: reservation.id }, biz.actor);
    expect(checkedIn.reservation.status).toBe('checked_in');
    expect((await mockPms.get(integration.id, reservation.external_reservation_id)).status).toBe('in_house');

    const noShow = await expectError(booking.applyOperation(biz.business, { action: 'no_show', booking_id: reservation.id }, biz.actor), 'unsupported_operation');
    expect(noShow.message).toMatch(/Front Desk PMS \(mock\)/);
    const unit = (await listMappings(biz.business.id, integration.id)).find((row) => row.kind === 'resource');
    const cleaning = await expectError(booking.applyOperation(biz.business, { action: 'mark_needs_cleaning', resource_id: Number(unit.resource_id) }, biz.actor), 'unsupported_operation');
    expect(cleaning.message).toMatch(/managed in the connected reservation system/);
    // No contradictory local status was written.
    expect((await query('SELECT operational_status FROM resources WHERE id = $1', [unit.resource_id])).rows[0].operational_status).toBe('ready');
    await expectError(booking.addMaintenance(biz.business, { resource_id: Number(unit.resource_id), starts_at: new Date('2027-04-01T00:00:00Z'), ends_at: new Date('2027-04-02T00:00:00Z') }, biz.actor), 'unsupported_operation');
    await expectError(create(stay('2027-05-01', '2027-05-02'), { waitlist_if_unavailable: true }), 'unsupported_operation');
  });
});

describe('synchronization', () => {
  it('applies changes made outside the platform and ignores duplicate deliveries', async () => {
    const { reservation } = await create(stay());
    // Created directly in the PMS — the platform has never seen it.
    const walkUp = await mockPms.create(integration.id, { type_external_id: 'DLX', guest_name: 'Desk Walk-up', party_size: 1,
      starts_at: new Date('2027-03-20T07:00:00Z'), ends_at: new Date('2027-03-21T04:00:00Z') });
    await mockPms.update(integration.id, reservation.external_reservation_id, { status: 'cancelled' }, 'reservation.cancelled');

    const first = await booking.externalBooking.reconcile(biz.business, integration.id);
    expect(first.results.map((item) => item.outcome)).toEqual(['stale', 'applied', 'applied']);
    expect((await bookingRow(reservation.id)).status).toBe('cancelled');   // the authoritative system cancelled it
    const mirror = (await local()).find((row) => row.external_reservation_id === walkUp.external_id);
    expect(mirror).toMatchObject({ status: 'confirmed', source: 'external', channel: 'external', reservation_name: 'Desk Walk-up', resource_id: null });

    // Deliver the same events again (missed-ack / replay): nothing changes.
    const snapshot = await local();
    await query('UPDATE integrations SET sync_cursor = NULL WHERE id = $1', [integration.id]);
    const replay = await booking.externalBooking.reconcile(biz.business, integration.id);
    expect(replay.results.every((item) => item.outcome === 'duplicate')).toBe(true);
    expect(await local()).toEqual(snapshot);
    const history = (await query(`SELECT outcome, COUNT(*)::int AS n FROM sync_events WHERE direction = 'inbound' GROUP BY outcome ORDER BY outcome`)).rows;
    expect(history).toEqual([{ outcome: 'applied', n: 2 }, { outcome: 'duplicate', n: 3 }, { outcome: 'stale', n: 1 }]);
  });

  it('does not let an older, late-arriving event overwrite newer state', async () => {
    const { reservation } = await create(stay());
    await mockPms.update(integration.id, reservation.external_reservation_id, { party_size: 1 });
    await mockPms.update(integration.id, reservation.external_reservation_id, { status: 'cancelled' }, 'reservation.cancelled');
    const { events } = await ctx_listChanges();
    const [, resize, cancel] = events;
    const row = (await query('SELECT * FROM integrations WHERE id = $1', [integration.id])).rows[0];

    // The cancellation arrives first, the earlier resize afterwards.
    const outOfOrder = await booking.externalBooking.applyInboundEvents(biz.business, row, [cancel, resize], 'webhook');
    expect(outOfOrder.map((item) => item.outcome)).toEqual(['applied', 'stale']);
    const final = await bookingRow(reservation.id);
    // The late "resize" event still says status=confirmed; applying it would have un-cancelled the reservation.
    expect(resize.reservation.status).toBe('confirmed');
    expect(final).toMatchObject({ status: 'cancelled' });
    expect(Number(final.external_version)).toBe(cancel.reservation.version);
  });

  async function ctx_listChanges() {
    const { mockExternalProvider } = await import('../../booking/providers/mockExternal.js');
    return mockExternalProvider.listChanges({ integration: { id: integration.id } }, null);
  }

  it('accepts only authenticated webhooks and processes them durably', async () => {
    const { reservation } = await create(stay());
    await mockPms.update(integration.id, reservation.external_reservation_id, { party_size: 1 });
    const { events } = await mockPms.changes(integration.id, 0);
    const body = JSON.stringify({ events: [events[events.length - 1]] });

    const forged = await request(app).post(`/api/webhooks/${integration.id}`).set('Content-Type', 'application/json')
      .set('X-Mock-Signature', signMockWebhook('wrong-secret', body)).send(body);
    expect(forged.status).toBe(401);
    expect((await bookingRow(reservation.id)).people).toBe(2);
    expect((await request(app).post('/api/webhooks/999999').set('Content-Type', 'application/json').send(body)).status).toBe(401);

    const genuine = await request(app).post(`/api/webhooks/${integration.id}`).set('Content-Type', 'application/json')
      .set('X-Mock-Signature', signMockWebhook(webhookSecret, body)).send(body);
    expect(genuine.body).toEqual({ received: 1, processed: true });
    expect((await bookingRow(reservation.id)).people).toBe(1);
    // The same webhook delivered twice is harmless.
    await request(app).post(`/api/webhooks/${integration.id}`).set('Content-Type', 'application/json')
      .set('X-Mock-Signature', signMockWebhook(webhookSecret, body)).send(body);
    expect((await query(`SELECT COUNT(*)::int AS n FROM sync_events WHERE outcome = 'applied' AND direction = 'inbound'`)).rows[0].n).toBe(1);
  });

  it('keeps reservations intact when synchronization fails, retries with backoff, and survives a restart', async () => {
    const { reservation } = await create(stay());
    await mockPms.update(integration.id, reservation.external_reservation_id, { party_size: 1 });
    await updateMockSettings(integration.id, { faults: { outage: true } });

    const jobId = await jobs.enqueueJob(null, { businessId: biz.business.id, integrationId: integration.id, kind: 'reconcile', dedupeKey: `integration:${integration.id}` });
    // Enqueuing the same work again does not create a second job.
    expect(await jobs.enqueueJob(null, { businessId: biz.business.id, integrationId: integration.id, kind: 'reconcile', dedupeKey: `integration:${integration.id}` })).toBe(jobId);
    const failed = await jobs.runJobNow(jobId);
    expect(failed).toMatchObject({ status: 'queued' });
    // A sync failure is not a cancellation.
    expect(await bookingRow(reservation.id)).toMatchObject({ status: 'confirmed', people: 2 });
    const job = (await query('SELECT * FROM sync_jobs WHERE id = $1', [jobId])).rows[0];
    expect(job).toMatchObject({ status: 'queued', attempts: 1 });
    expect(job.last_error).toMatch(/not responding/);
    expect(new Date(job.run_after).getTime()).toBeGreaterThan(Date.now());   // backed off
    expect(await jobs.runDueJobs()).toEqual([]);                              // not due yet

    // A worker crashed mid-job: the job is recovered rather than lost.
    await query(`UPDATE sync_jobs SET status = 'running', locked_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [jobId]);
    expect(await jobs.recoverStaleJobs()).toBe(1);

    await updateMockSettings(integration.id, { faults: { outage: false } });
    const rerun = await jobs.runDueJobs({ ignoreSchedule: true });
    expect(rerun).toEqual([expect.objectContaining({ id: jobId, status: 'succeeded' })]);
    expect((await bookingRow(reservation.id)).people).toBe(1);
    expect((await query('SELECT last_reconciled_at, last_error FROM integrations WHERE id = $1', [integration.id])).rows[0].last_error).toBeNull();
  });

  it('gives up on a job only after its attempts are exhausted and reports it', async () => {
    await updateMockSettings(integration.id, { faults: { outage: true } });
    const jobId = await jobs.enqueueJob(null, { businessId: biz.business.id, integrationId: integration.id, kind: 'reconcile', dedupeKey: 'x', maxAttempts: 2 });
    await jobs.runJobNow(jobId);
    const [last] = await jobs.runDueJobs({ ignoreSchedule: true });
    expect(last.status).toBe('dead');
    const health = await request(app).get(`/api/b/${biz.business.id}/sync/jobs`).set('Authorization', `Bearer ${tokenFor(biz.owner)}`);
    expect(health.body.counts).toEqual({ dead: 1 });
  });
});
