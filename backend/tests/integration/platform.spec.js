// Business isolation, server-side authorization and configurable inventory.
import request from 'supertest';
import { resetDb, closeDb, makeBusiness, makeUser, idem } from '../helpers/db.js';
import { loadApp } from '../helpers/app.js';
import { query } from '../../services/db.js';

const ctx = await loadApp();
const { app, tokenFor } = ctx;
const booking = await import('../../booking/service.js');

const api = (user) => {
  const call = (method) => (path) => request(app)[method](path).set('Authorization', `Bearer ${tokenFor(user)}`);
  return { get: call('get'), post: call('post'), patch: call('patch'), delete: call('delete') };
};
const table = (start_time = '19:00') => ({ service_type: 'restaurant', date: '2027-05-05', start_time, people: 2 });

let alpha;
let beta;
beforeEach(async () => {
  await resetDb();
  ctx.resetMocks();
  const restaurant = { settings: { default_duration_minutes: 60, turnover_buffer_minutes: 0 },
    types: [{ name: 'Standard indoor table', defaults: { seating_capacity: 4, seating_area: 'indoor' }, codes: ['T01', 'T02'] }] };
  alpha = await makeBusiness({ slug: 'alpha', restaurant });
  beta = await makeBusiness({ slug: 'beta', restaurant });
});
afterAll(closeDb);

describe('two businesses with identical table codes', () => {
  it('keeps inventory, reservations, customers and audit history apart', async () => {
    const a = await booking.createReservation(alpha.business, { ...table(), idempotency_key: idem(), customer: { name: 'Shared Name', phone: '0811111111' }, channel: 'phone' }, alpha.actor);
    // The very same table code, time and phone number in another business is independent.
    const b = await booking.createReservation(beta.business, { ...table(), idempotency_key: idem(), customer: { name: 'Shared Name', phone: '0811111111' }, channel: 'phone' }, beta.actor);
    expect(a.reservation.resource.code).toBe('T01');
    expect(b.reservation.resource.code).toBe('T01');
    expect(a.reservation.resource.id).not.toBe(b.reservation.resource.id);

    const listA = await api(alpha.owner).get(`/api/b/${alpha.business.id}/reservations`);
    expect(listA.body.map((item) => item.id)).toEqual([a.reservation.id]);
    const resourcesA = await api(alpha.owner).get(`/api/b/${alpha.business.id}/resources`);
    expect(resourcesA.body.map((item) => item.code)).toEqual(['T01', 'T02']);
    expect(resourcesA.body.every((item) => item.id !== b.reservation.resource.id)).toBe(true);

    const customers = (await query('SELECT business_id, phone_number FROM customers ORDER BY business_id')).rows;
    expect(customers.map((row) => Number(row.business_id))).toEqual([Number(alpha.business.id), Number(beta.business.id)]);
    const auditA = await api(alpha.owner).get(`/api/b/${alpha.business.id}/audit?entity=booking`);
    expect(auditA.body.map((row) => row.entity_id)).toEqual([String(a.reservation.id)]);
  });

  it('answers 404 for another business and for another business\'s reservation or resource', async () => {
    const theirs = await booking.createReservation(beta.business, { ...table(), idempotency_key: idem(), customer: { name: 'Beta Guest' }, channel: 'phone' }, beta.actor);
    const mine = api(alpha.owner);

    expect((await mine.get(`/api/b/${beta.business.id}`)).status).toBe(404);
    expect((await mine.get(`/api/b/${beta.business.id}/reservations`)).status).toBe(404);
    // A valid ID from another business, addressed through my own business.
    expect((await mine.get(`/api/b/${alpha.business.id}/reservations/${theirs.reservation.id}`)).status).toBe(404);
    expect((await mine.post(`/api/b/${alpha.business.id}/reservations/${theirs.reservation.id}/cancel`).send({})).status).toBe(404);
    expect((await mine.patch(`/api/b/${alpha.business.id}/reservations/${theirs.reservation.id}`).send({ changes: { people: 3 } })).status).toBe(404);
    expect((await mine.patch(`/api/b/${alpha.business.id}/resources/${beta.resources.T01}`).send({ name: 'hijack' })).status).toBe(404);
    expect((await mine.post(`/api/b/${alpha.business.id}/operations/actions`).send({ action: 'mark_out_of_service', resource_id: beta.resources.T01 })).status).toBe(404);
    // Booking my own service onto their table is refused by the engine.
    const cross = await mine.post(`/api/b/${alpha.business.id}/reservations`).send({ ...table('12:00'), resource_id: beta.resources.T01,
      idempotency_key: idem(), customer: { name: 'Cross' } });
    expect(cross.status).toBe(409);

    expect((await query('SELECT status, people FROM bookings WHERE id = $1', [theirs.reservation.id])).rows[0]).toEqual({ status: 'confirmed', people: 2 });
    expect((await query('SELECT name, operational_status FROM resources WHERE id = $1', [beta.resources.T01])).rows[0]).toEqual({ name: '', operational_status: 'ready' });
  });

  it('ignores a business ID supplied in the request body', async () => {
    const res = await api(alpha.owner).post(`/api/b/${alpha.business.id}/reservations`)
      .send({ ...table(), business_id: beta.business.id, idempotency_key: idem(), customer: { name: 'Body Trick' } });
    expect(res.status).toBe(400);   // unknown field is rejected outright
    expect((await query('SELECT COUNT(*)::int AS n FROM bookings')).rows[0].n).toBe(0);
  });
});

describe('authentication and roles', () => {
  it('has no authentication shortcuts on business routes', async () => {
    process.env.ADMIN_TOKEN = 'admin-secret';
    process.env.ALLOW_PUBLIC_ADMIN_ACCESS = 'true';
    const path = `/api/b/${alpha.business.id}/reservations`;
    expect((await request(app).get(path)).status).toBe(401);
    expect((await request(app).get(path).set('X-Admin-Token', 'admin-secret')).status).toBe(401);
    expect((await request(app).get(path).set('Authorization', 'Bearer admin-secret')).status).toBe(401);
    for (const legacy of ['/api/inventory', '/api/settings/audit', '/api/analytics/summary', '/api/bookings']) {
      expect((await request(app).get(legacy).set('X-Admin-Token', 'admin-secret')).status).toBe(404);
    }
    process.env.ADMIN_TOKEN = '';
    process.env.ALLOW_PUBLIC_ADMIN_ACCESS = '';
  });

  it('gives an existing account no access to a business it does not belong to, even with a global admin role', async () => {
    const globalAdmin = await makeUser('old-admin@example.test', 'admin');
    expect((await api(globalAdmin).get(`/api/b/${alpha.business.id}`)).status).toBe(404);
    expect((await api(globalAdmin).get('/api/businesses')).body).toEqual([]);
  });

  it('lets staff run reservations and operations but not configuration, integrations or access', async () => {
    const staff = await makeUser('staff@example.test');
    const added = await api(alpha.owner).post(`/api/b/${alpha.business.id}/members`).send({ email: staff.email, role: 'staff' });
    expect(added.status).toBe(200);
    const asStaff = api(staff);

    const created = await asStaff.post(`/api/b/${alpha.business.id}/reservations`).send({ ...table(), idempotency_key: idem(), customer: { name: 'Phone Guest' }, channel: 'phone' });
    expect(created.status).toBe(201);
    expect((await asStaff.get(`/api/b/${alpha.business.id}/operations/board`)).status).toBe(200);

    expect((await asStaff.post(`/api/b/${alpha.business.id}/resource-types`).send({ service_type: 'restaurant', name: 'X' })).status).toBe(403);
    expect((await asStaff.patch(`/api/b/${alpha.business.id}/services/restaurant`).send({ enabled: false })).status).toBe(403);
    expect((await asStaff.get(`/api/b/${alpha.business.id}/integrations`)).status).toBe(403);
    expect((await asStaff.post(`/api/b/${alpha.business.id}/members`).send({ email: staff.email, role: 'owner' })).status).toBe(403);
    expect((await asStaff.get(`/api/b/${alpha.business.id}/audit`)).status).toBe(403);
    // Staff of alpha are nobody at beta.
    expect((await asStaff.get(`/api/b/${beta.business.id}/reservations`)).status).toBe(404);
  });

  it('keeps at least one owner and lets only owners grant ownership', async () => {
    const admin = await makeUser('admin@example.test');
    await api(alpha.owner).post(`/api/b/${alpha.business.id}/members`).send({ email: admin.email, role: 'admin' });
    expect((await api(admin).post(`/api/b/${alpha.business.id}/members`).send({ email: admin.email, role: 'owner' })).status).toBe(403);
    const members = await api(alpha.owner).get(`/api/b/${alpha.business.id}/members`);
    const ownerMembership = members.body.find((member) => member.role === 'owner');
    expect((await api(alpha.owner).delete(`/api/b/${alpha.business.id}/members/${ownerMembership.id}`)).status).toBe(400);
  });
});

describe('configurable inventory', () => {
  const base = () => `/api/b/${alpha.business.id}`;
  const owner = () => api(alpha.owner);

  it('previews generated codes and creates exactly that many distinct physical tables', async () => {
    const type = (await owner().post(`${base()}/resource-types`).send({ service_type: 'restaurant', name: 'Private table',
      defaults: { seating_capacity: 8, seating_area: 'private', min_spend: '3000' } })).body;

    const preview = await owner().post(`${base()}/resources/preview`).send({ resource_type_id: type.id, quantity: 10, prefix: 'T', start_number: 1, pad: 2 });
    expect(preview.body.items.map((item) => item.code)).toEqual(['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10']);
    // T01 and T02 already exist in this business.
    expect(preview.body.valid).toBe(false);
    expect(preview.body.items.filter((item) => item.problem).map((item) => [item.code, item.problem])).toEqual([['T01', 'already_exists'], ['T02', 'already_exists']]);

    const before = (await query('SELECT COUNT(*)::int AS n FROM resources WHERE business_id = $1', [alpha.business.id])).rows[0].n;
    const rejected = await owner().post(`${base()}/resources/batch`).send({ resource_type_id: type.id, quantity: 10, prefix: 'T', start_number: 1, pad: 2 });
    expect(rejected.status).toBe(400);
    // Atomic: not even the eight valid codes were saved.
    expect((await query('SELECT COUNT(*)::int AS n FROM resources WHERE business_id = $1', [alpha.business.id])).rows[0].n).toBe(before);

    const created = await owner().post(`${base()}/resources/batch`).send({ resource_type_id: type.id, quantity: 10, prefix: 'P', start_number: 1, pad: 2 });
    expect(created.status).toBe(201);
    expect(created.body).toHaveLength(10);
    expect(new Set(created.body.map((item) => item.id)).size).toBe(10);
    expect(created.body.map((item) => item.code)).toEqual(['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10']);
    const rows = (await query(`SELECT code FROM resources WHERE resource_type_id = $1 ORDER BY code`, [type.id])).rows;
    expect(rows).toHaveLength(10);

    const duplicateInBatch = await owner().post(`${base()}/resources/preview`).send({ resource_type_id: type.id, codes: ['V1', 'v1', 'V2'] });
    expect(duplicateInBatch.body.items.map((item) => item.problem)).toEqual(['duplicate_in_batch', 'duplicate_in_batch', null]);
  });

  it('inherits type defaults, applies individual overrides, and resets to the default', async () => {
    const type = (await owner().post(`${base()}/resource-types`).send({ service_type: 'restaurant', name: 'Private table',
      defaults: { seating_capacity: 8, seating_area: 'private', min_spend: '3000' } })).body;
    const [, p02] = (await owner().post(`${base()}/resources/batch`).send({ resource_type_id: type.id, codes: ['P01', 'P02'] })).body;

    let resources = (await owner().get(`${base()}/resources?service_type=restaurant`)).body;
    let p2 = resources.find((item) => item.id === p02.id);
    expect(p2.effective.values).toMatchObject({ seating_capacity: 8, min_spend: '3000', default_duration_minutes: 60, turnover_buffer_minutes: 0 });
    expect(p2.effective.sources).toMatchObject({ seating_capacity: 'type', min_spend: 'type', default_duration_minutes: 'service', booking_fee: 'platform' });

    const overridden = await owner().patch(`${base()}/resources/${p02.id}`).send({ overrides: { min_spend: '5000', seating_capacity: 10 } });
    expect(overridden.body.effective.values).toMatchObject({ min_spend: '5000', seating_capacity: 10 });
    expect(overridden.body.effective.sources).toMatchObject({ min_spend: 'resource', seating_capacity: 'resource', seating_area: 'type' });
    // P01 is untouched by P02's override.
    resources = (await owner().get(`${base()}/resources?service_type=restaurant`)).body;
    expect(resources.find((item) => item.code === 'P01').effective.values.min_spend).toBe('3000');

    const reset = await owner().patch(`${base()}/resources/${p02.id}`).send({ reset: ['min_spend'] });
    expect(reset.body.overrides).toEqual({ seating_capacity: 10 });
    expect(reset.body.effective.values.min_spend).toBe('3000');
    expect(reset.body.effective.sources.min_spend).toBe('type');

    // A type-level change flows to resources that still inherit it.
    await owner().patch(`${base()}/resource-types/${type.id}`).send({ defaults: { seating_capacity: 8, seating_area: 'private', min_spend: '3500' } });
    p2 = (await owner().get(`${base()}/resources?service_type=restaurant`)).body.find((item) => item.id === p02.id);
    expect(p2.effective.values).toMatchObject({ min_spend: '3500', seating_capacity: 10 });

    const invalid = await owner().patch(`${base()}/resources/${p02.id}`).send({ overrides: { check_in_time: '14:00' } });
    expect(invalid.status).toBe(400);   // hotel-only field on a table
  });

  it('does not let a configuration change silently invalidate an existing booking', async () => {
    const held = await booking.createReservation(alpha.business, { ...table(), people: 4, resource_id: alpha.resources.T01,
      idempotency_key: idem(), customer: { name: 'Party of four' }, channel: 'phone' }, alpha.actor);

    const blocked = await owner().patch(`${base()}/resources/${alpha.resources.T01}`).send({ overrides: { seating_capacity: 2 } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'config_conflict' });
    expect(blocked.body.error.details.affected_bookings[0]).toMatchObject({ booking_id: held.reservation.id, reason: 'party_exceeds_new_capacity' });

    const acknowledged = await owner().patch(`${base()}/resources/${alpha.resources.T01}`).send({ overrides: { seating_capacity: 2 }, acknowledge_conflicts: true });
    expect(acknowledged.status).toBe(200);
    // The existing commitment is intact; only new requests see the new capacity.
    expect((await booking.getReservation(alpha.business, held.reservation.id))).toMatchObject({ status: 'confirmed', people: 4 });
    const fresh = await booking.checkAvailability(alpha.business, { ...table('12:00'), people: 4, resource_id: alpha.resources.T01 });
    expect(fresh.reason.code).toBe('capacity');
  });

  it('archives a resource that has history and refuses while it still has upcoming reservations', async () => {
    const held = await booking.createReservation(alpha.business, { ...table(), resource_id: alpha.resources.T01,
      idempotency_key: idem(), customer: { name: 'History' }, channel: 'phone' }, alpha.actor);

    const refused = await owner().delete(`${base()}/resources/${alpha.resources.T01}`);
    expect(refused.status).toBe(409);
    await booking.cancelReservation(alpha.business, held.reservation.id, {}, alpha.actor);

    const archived = await owner().delete(`${base()}/resources/${alpha.resources.T01}`);
    expect(archived.body).toEqual({ archived: true, deleted: false });
    const row = (await query('SELECT archived_at, is_active FROM resources WHERE id = $1', [alpha.resources.T01])).rows[0];
    expect(row.archived_at).not.toBeNull();
    expect((await query('SELECT resource_id FROM bookings WHERE id = $1', [held.reservation.id])).rows[0].resource_id).toBe(String(alpha.resources.T01));
    // The code can be reused, and the archived table is no longer offered.
    expect((await owner().post(`${base()}/resources/batch`).send({ resource_type_id: alpha.types['Standard indoor table'].id, codes: ['T01'] })).status).toBe(201);

    const unused = await owner().delete(`${base()}/resources/${alpha.resources.T02}`);
    expect(unused.body).toEqual({ archived: false, deleted: true });
  });

  it('uses service-specific labels for capacity', async () => {
    const services = (await owner().get(base())).body.services;
    const labels = Object.fromEntries(services.map((service) => [service.service_type, Object.fromEntries(service.fields.map((field) => [field.key, field.label]))]));
    expect(labels.hotel.max_guests).toBe('Maximum guests');
    expect(labels.restaurant.seating_capacity).toBe('Seating capacity');
    expect(labels.meeting.layouts).toBe('Capacity by layout');
  });
});
