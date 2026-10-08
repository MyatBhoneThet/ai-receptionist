// Migrating a real pre-platform database: every existing row must survive,
// ambiguous reservations must be reported (never guessed), and the legacy
// business must not open for booking until an owner has resolved them.
// Uses its own throwaway database built from the old db/schema.sql.
import { readFile } from 'node:fs/promises';
import pkg from 'pg';
import { runMigrations, legacyReviewReport } from '../../scripts/migrate.js';

const { Client, Pool } = pkg;
const baseUrl = new URL(process.env.DATABASE_URL);
const DB_NAME = `${baseUrl.pathname.slice(1)}_migration`;
let pool;

async function recreateDatabase() {
  if (!/test/i.test(DB_NAME)) throw new Error('Refusing to recreate a non-test database.');
  if (pool) await pool.end();
  const admin = new URL(baseUrl); admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
  await client.query(`CREATE DATABASE "${DB_NAME}"`);
  await client.end();
  const target = new URL(baseUrl); target.pathname = `/${DB_NAME}`;
  pool = new Pool({ connectionString: target.toString() });
  await pool.query(await readFile(new URL('../../../db/schema.sql', import.meta.url), 'utf8'));
}

async function seedLegacyData() {
  await pool.query(`
    INSERT INTO users (email, password_hash, name, role) VALUES
      ('boss@old.test', 'hash', 'Boss', 'admin'), ('desk@old.test', 'hash', 'Desk', 'staff'),
      ('second-admin@old.test', 'hash', 'Second', 'admin'), ('guest@old.test', 'hash', 'Guest', 'customer');
    INSERT INTO customers (name, phone_number, preferences) VALUES ('Avery', '0800123456', '{"dietary":"vegan"}'), ('Jordan', '0800111222', '{}');
    -- Numeric IDs overlap across the three legacy tables: each has an id = 1.
    INSERT INTO hotel_rooms (id, room_number, room_type, floor, capacity, price_per_night, amenities) VALUES
      (1, '101', 'Deluxe', 1, 2, 2500.00, '{"wifi":true,"balcony":true,"tv":false}'),
      (2, '102', 'Deluxe', 1, 3, 2500.00, '{"wifi":true,"balcony":true,"tv":false}'),
      (3, '201', 'Suite', 2, 4, 4800.50, '{"wifi":true}');
    INSERT INTO restaurant_tables (id, table_number, capacity, location) VALUES (1, 'T1', 4, 'indoor'), (2, 'T2', 2, 'patio');
    INSERT INTO meeting_rooms (id, room_name, room_code, capacity, equipment) VALUES (1, 'Executive Boardroom', 'BOARD', 12, '{"projector":true}');

    INSERT INTO bookings (id, session_id, service_type, hotel_room_id, table_id, meeting_room_id, customer_id, reservation_name, contact_phone,
                          people, date, end_date, start_time, end_time, status, waitlisted, notes, google_event_id) VALUES
      (10, 's-hotel',   'hotel',      1, NULL, NULL, 1, 'Avery',  '0800123456', 2, '2031-03-10', '2031-03-13', '14:00', '11:00', 'confirmed', FALSE, 'Late arrival', 'gcal-10'),
      (11, 's-table',   'restaurant', NULL, 1, NULL, 2, 'Jordan', '0800111222', 4, '2031-03-10', NULL, '18:30', '19:30', 'confirmed', FALSE, '', NULL),
      (12, 's-meet',    'meeting',    NULL, NULL, 1, NULL, 'Kai', '0800333444', 6, '2031-03-11', NULL, '10:00', '12:00', 'modified', FALSE, '', NULL),
      -- Confirmed, upcoming, but no table was ever recorded.
      (13, 's-noroom',  'restaurant', NULL, NULL, NULL, NULL, 'Unassigned', '0800555666', 2, '2031-03-12', NULL, '19:00', '20:00', 'confirmed', FALSE, '', NULL),
      -- Overlaps booking 11 on the same table: an existing double booking.
      (14, 's-double',  'restaurant', NULL, 1, NULL, NULL, 'Clash', '0800777888', 2, '2031-03-10', NULL, '19:00', '20:00', 'confirmed', FALSE, '', NULL),
      -- A chat draft that was holding table T2 under the old semantics.
      (15, 's-draft',   'restaurant', NULL, 2, NULL, NULL, 'Draft', '0800999000', 2, '2031-03-14', NULL, '12:00', NULL, 'pending', FALSE, '', NULL),
      (16, 's-wait',    'hotel',      NULL, NULL, NULL, NULL, 'Waiting', '0800121212', 2, '2031-03-10', '2031-03-12', '14:00', '11:00', 'pending', TRUE, '', NULL),
      (17, 's-gone',    'hotel',      3, NULL, NULL, NULL, 'Cancelled', '0800343434', 2, '2031-03-10', '2031-03-12', '14:00', '11:00', 'cancelled', FALSE, '', NULL),
      -- End before start.
      (18, 's-badtime', 'meeting',    NULL, NULL, 1, NULL, 'Backwards', '0800565656', 3, '2031-03-15', NULL, '15:00', '14:00', 'confirmed', FALSE, '', NULL),
      -- Long past and unassigned: preserved, reported, but not a blocker.
      (19, 's-old',     'restaurant', NULL, NULL, NULL, NULL, 'Old', '0800787878', 2, '2019-01-05', NULL, '19:00', '20:00', 'confirmed', FALSE, '', NULL),
      -- A room recorded against the wrong kind of reservation.
      (20, 's-mismatch','restaurant', 1, NULL, NULL, NULL, 'Mismatch', '0800909090', 2, '2031-03-16', NULL, '19:00', '20:00', 'confirmed', FALSE, '', NULL);
    SELECT setval('bookings_id_seq', 20);
    INSERT INTO conversations (session_id, role, content) VALUES ('s-hotel', 'user', 'A room please'), ('s-hotel', 'assistant', 'Of course');
    INSERT INTO app_settings (key, value) VALUES ('staff_webhook_url', '{"value":"https://hooks.example.test/x"}');
    INSERT INTO audit_logs (actor_email, action, entity, entity_id, before_state, after_state)
      VALUES ('boss@old.test', 'update', 'booking', 10, '{"people":1}', '{"people":2}');
  `);
}

const rows = async (sql, params) => (await pool.query(sql, params)).rows;

afterAll(async () => { if (pool) await pool.end(); });

describe('migrating existing single-business data', () => {
  let before;
  beforeAll(async () => {
    await recreateDatabase();
    await seedLegacyData();
    before = await rows(`SELECT id, session_id, service_type, reservation_name, contact_phone, people, date::text, end_date::text,
      start_time::text, end_time::text, status, waitlisted, notes, google_event_id, customer_id, hotel_room_id, table_id, meeting_room_id, created_at
      FROM bookings ORDER BY id`);
  });

  it('refuses to guess the timezone of existing dates and rolls back cleanly', async () => {
    await expect(runMigrations(pool, {})).rejects.toThrow(/LEGACY_BUSINESS_TIMEZONE/);
    await expect(runMigrations(pool, { timezone: 'Mars/Olympus' })).rejects.toThrow(/not a known IANA timezone/);
    // 001 applied; 002 rolled back entirely — no half-migrated schema.
    expect((await rows(`SELECT version FROM schema_migrations`)).map((row) => row.version)).toEqual(['001_baseline']);
    expect((await rows(`SELECT to_regclass('businesses') AS t`))[0].t).toBeNull();
    expect((await rows('SELECT COUNT(*)::int AS n FROM bookings'))[0].n).toBe(11);
  });

  it('applies every migration and is a no-op when run again', async () => {
    const applied = await runMigrations(pool, { timezone: 'Asia/Bangkok', name: 'Lumière Hotel', slug: 'lumiere' });
    expect(applied).toEqual(['002_businesses', '003_inventory', '004_reservations', '005_integrations']);
    expect(await runMigrations(pool, { timezone: 'Asia/Bangkok' })).toEqual([]);
  });

  it('preserves every reservation, customer, conversation, setting and audit entry', async () => {
    const after = await rows(`SELECT id, session_id, service_type, reservation_name, contact_phone, people, date::text, end_date::text,
      start_time::text, end_time::text, status, waitlisted, notes, google_event_id, customer_id, hotel_room_id, table_id, meeting_room_id, created_at
      FROM bookings ORDER BY id`);
    expect(after).toEqual(before);
    const legacy = (await rows('SELECT * FROM businesses'))[0];
    expect(legacy).toMatchObject({ name: 'Lumière Hotel', slug: 'lumiere', timezone: 'Asia/Bangkok', is_legacy: true });
    for (const tableName of ['bookings', 'customers', 'conversations', 'app_settings', 'audit_logs']) {
      const scoped = await rows(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE business_id = $1)::int AS mine FROM ${tableName}`, [legacy.id]);
      expect(scoped[0].n).toBeGreaterThan(0);
      expect(scoped[0].mine).toBe(scoped[0].n);
    }
    expect((await rows(`SELECT name, phone_number, preferences FROM customers ORDER BY id`))[0]).toEqual({ name: 'Avery', phone_number: '0800123456', preferences: { dietary: 'vegan' } });
    expect((await rows(`SELECT actor_email, action, entity, entity_id, after_state FROM audit_logs`))[0])
      .toEqual({ actor_email: 'boss@old.test', action: 'update', entity: 'booking', entity_id: '10', after_state: { people: 2 } });
    expect((await rows(`SELECT value FROM app_settings WHERE key = 'staff_webhook_url'`))[0].value).toEqual({ value: 'https://hooks.example.test/x' });
  });

  it('keeps existing accounts but grants staff access only to the legacy business', async () => {
    const members = await rows(`SELECT u.email, m.role FROM business_memberships m JOIN users u ON u.id = m.user_id ORDER BY u.id`);
    expect(members).toEqual([{ email: 'boss@old.test', role: 'owner' }, { email: 'desk@old.test', role: 'staff' }, { email: 'second-admin@old.test', role: 'admin' }]);
    expect((await rows('SELECT COUNT(*)::int AS n FROM users'))[0].n).toBe(4);
  });

  it('gives overlapping legacy IDs distinct resources and resolves each booking by its own service', async () => {
    const resources = await rows(`SELECT r.id, r.service_type, r.code, r.legacy_table, r.legacy_id, r.overrides, t.name AS type_name, t.defaults
                                  FROM resources r JOIN resource_types t ON t.id = r.resource_type_id ORDER BY r.id`);
    expect(resources).toHaveLength(6);
    expect(new Set(resources.map((row) => row.id)).size).toBe(6);
    const legacyOne = resources.filter((row) => row.legacy_id === 1);
    expect(legacyOne.map((row) => [row.legacy_table, row.code])).toEqual([['hotel_rooms', '101'], ['restaurant_tables', 'T1'], ['meeting_rooms', 'BOARD']]);

    const assigned = await rows(`SELECT b.id, r.code, r.service_type FROM bookings b JOIN resources r ON r.id = b.resource_id WHERE b.id IN (10, 11, 12) ORDER BY b.id`);
    expect(assigned).toEqual([{ id: 10, code: '101', service_type: 'hotel' }, { id: 11, code: 'T1', service_type: 'restaurant' }, { id: 12, code: 'BOARD', service_type: 'meeting' }]);

    // Legacy columns became type defaults with per-room overrides only where they differ.
    const room101 = resources.find((row) => row.code === '101');
    const room102 = resources.find((row) => row.code === '102');
    expect(room101.type_name).toBe('Deluxe');
    expect(room101.defaults).toEqual({ max_guests: 2, base_rate: '2500.00', amenities: ['balcony', 'wifi'] });
    expect(room101.overrides).toEqual({ floor: 1 });
    expect(room102.overrides).toEqual({ floor: 1, max_guests: 3 });
    expect(resources.find((row) => row.code === '201').defaults.base_rate).toBe('4800.50');
    expect(resources.find((row) => row.code === 'T2').defaults).toEqual({ seating_capacity: 2, seating_area: 'patio' });
    expect(resources.find((row) => row.code === 'BOARD').overrides).toEqual({ layouts: [{ name: 'Standard', capacity: 12 }], equipment: ['projector'] });
  });

  it('interprets existing dates and times in the legacy business timezone', async () => {
    const hotel = (await rows(`SELECT starts_at, ends_at, lower(hold_period) AS hold_start FROM bookings WHERE id = 10`))[0];
    expect(hotel.starts_at.toISOString()).toBe('2031-03-10T07:00:00.000Z');   // 14:00 in Bangkok
    expect(hotel.ends_at.toISOString()).toBe('2031-03-13T04:00:00.000Z');     // 11:00 in Bangkok
    expect(hotel.hold_start.toISOString()).toBe('2031-03-10T07:00:00.000Z');
    const dinner = (await rows(`SELECT starts_at, ends_at FROM bookings WHERE id = 11`))[0];
    expect(dinner.starts_at.toISOString()).toBe('2031-03-10T11:30:00.000Z');
    // A missing end time keeps the one hour the old application assumed.
    const draft = (await rows(`SELECT starts_at, ends_at FROM bookings WHERE id = 15`))[0];
    expect((draft.ends_at - draft.starts_at) / 60000).toBe(60);
  });

  it('reports ambiguous reservations for review instead of guessing an assignment', async () => {
    const report = await legacyReviewReport(pool);
    const byId = Object.fromEntries(report.items.map((item) => [item.id, [item.review_reason, item.blocking]]));
    expect(byId).toEqual({
      13: ['missing_resource_assignment', true],
      14: ['double_booked', true],
      15: ['legacy_pending_hold', false],
      18: ['invalid_time_range', true],
      19: ['missing_resource_assignment', false],
      20: ['resource_service_mismatch', true],
    });
    // Nothing was invented for them.
    expect((await rows(`SELECT id, resource_id FROM bookings WHERE id IN (13, 19, 20) ORDER BY id`)).map((row) => row.resource_id)).toEqual([null, null, null]);
    // The wrongly typed room column was not used to seat a restaurant booking in hotel room 101.
    expect((await rows(`SELECT hotel_room_id FROM bookings WHERE id = 20`))[0].hotel_room_id).toBe(1);
  });

  it('keeps legitimate commitments: an old pending draft still holds its table, and both sides of a double booking remain', async () => {
    const draft = (await rows(`SELECT status, hold_period IS NOT NULL AS holds, legacy_review FROM bookings WHERE id = 15`))[0];
    expect(draft).toEqual({ status: 'pending', holds: true, legacy_review: false });
    const clash = await rows(`SELECT id, status, legacy_review FROM bookings WHERE id IN (11, 14) ORDER BY id`);
    expect(clash).toEqual([{ id: 11, status: 'confirmed', legacy_review: false }, { id: 14, status: 'confirmed', legacy_review: true }]);
    // The no-double-booking constraint is live for everything else.
    const legacyId = (await rows('SELECT id FROM businesses'))[0].id;
    await expect(pool.query(
      `INSERT INTO bookings (business_id, session_id, service_type, resource_id, status, hold_period)
       SELECT $1, 'new', 'restaurant', resource_id, 'confirmed', hold_period FROM bookings WHERE id = 15`, [legacyId])).rejects.toMatchObject({ code: '23P01' });
    // The waitlisted and cancelled rows hold nothing.
    expect((await rows(`SELECT id, hold_period IS NOT NULL AS holds FROM bookings WHERE id IN (16, 17) ORDER BY id`)))
      .toEqual([{ id: 16, holds: false }, { id: 17, holds: true }]);
    expect((await rows(`SELECT waitlisted, status FROM bookings WHERE id = 16`))[0]).toEqual({ waitlisted: true, status: 'pending' });
  });

  it('requires currency confirmation and blocks activation while ambiguity remains', async () => {
    const legacy = (await rows('SELECT currency, currency_confirmed, status FROM businesses'))[0];
    expect(legacy).toEqual({ currency: null, currency_confirmed: false, status: 'setup' });
    const services = await rows('SELECT service_type, enabled, booking_source, settings FROM business_services ORDER BY service_type');
    expect(services.map((row) => [row.service_type, row.enabled, row.booking_source])).toEqual([['hotel', true, 'internal'], ['meeting', true, 'internal'], ['restaurant', true, 'internal']]);
    expect(services[0].settings).toMatchObject({ check_in_time: '14:00', check_out_time: '11:00' });
  });
});

describe('migrating clean data with a known currency', () => {
  it('opens the legacy business automatically when nothing needs a decision', async () => {
    await recreateDatabase();
    await pool.query(`
      INSERT INTO users (email, password_hash, role) VALUES ('boss@old.test', 'hash', 'admin');
      INSERT INTO restaurant_tables (id, table_number, capacity, location) VALUES (1, 'T1', 4, 'indoor');
      INSERT INTO bookings (session_id, service_type, table_id, reservation_name, people, date, start_time, end_time, status)
        VALUES ('s', 'restaurant', 1, 'Jordan', 4, '2031-03-10', '18:30', '19:30', 'confirmed');`);
    await runMigrations(pool, { timezone: 'Europe/London', currency: 'gbp' });
    expect((await rows('SELECT currency, currency_confirmed, status, timezone FROM businesses'))[0])
      .toEqual({ currency: 'GBP', currency_confirmed: true, status: 'active', timezone: 'Europe/London' });
    expect((await legacyReviewReport(pool)).items).toEqual([]);
  });

  it('creates no legacy business for an empty database', async () => {
    await recreateDatabase();
    await runMigrations(pool, {});
    expect((await rows('SELECT COUNT(*)::int AS n FROM businesses'))[0].n).toBe(0);
    expect((await legacyReviewReport(pool)).business).toBeNull();
  });
});
