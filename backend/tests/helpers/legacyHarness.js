// Lets the pre-platform chat regression scenarios run unchanged in spirit
// against real PostgreSQL. The old suite kept fixtures in in-memory arrays
// (`state.bookings`, `state.inventory`) behind a SQL-string mock; here the same
// arrays are written to the test database before each request and re-read
// after it, so every assertion is about real rows.
import supertest from 'supertest';
import pool, { query } from '../../services/db.js';
import { resetDb, makeUser } from './db.js';
import { createBusiness, getBusiness, updateService } from '../../platform/businesses.js';
import { setBusinessSetting } from '../../services/appSettings.js';

const SERVICE_OF = { room: 'hotel', table: 'restaurant', meeting: 'meeting' };
const FK_OF = { hotel: 'hotel_room_id', restaurant: 'table_id', meeting: 'meeting_room_id' };
const COLUMNS = ['session_id', 'service_type', 'date', 'end_date', 'start_time', 'end_time', 'reservation_name', 'people', 'notes',
  'status', 'waitlisted', 'contact_email', 'contact_phone', 'google_event_id'];

const dateKey = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

export function createLegacyHarness(ctx) {
  const h = {
    state: { bookings: [], inventory: [], conversations: [] },
    business: null,
    owner: null,
    resourceByMockId: new Map(),   // legacy mock id (inventory*1000 + unit) → resources.id
    mockIdByResource: new Map(),
    signatures: new Map(),
    flushedInventory: new Set(),
    typeNames: new Set(),

    async reset(initialBookings = []) {
      await resetDb();
      h.owner = await makeUser('owner@legacy.test');
      const created = await createBusiness(h.owner, { name: 'Lumière', slug: 'lumiere', timezone: 'Asia/Bangkok', currency: 'THB',
        services: ['hotel', 'restaurant', 'meeting'].map((service_type) => ({ service_type, enabled: true, booking_source: 'internal' })) });
      h.business = await getBusiness(created.id);
      const actor = { email: h.owner.email, userId: h.owner.id };
      // The rules the pre-platform application effectively applied.
      await updateService(h.business, 'restaurant', { settings: { default_duration_minutes: 60, turnover_buffer_minutes: 0 } }, actor);
      await updateService(h.business, 'meeting', { settings: { min_duration_minutes: 30, increment_minutes: 15 } }, actor);
      await setBusinessSetting(h.business.id, 'google_calendar_id', 'test-calendar');
      await query(`UPDATE businesses SET status = 'active', activated_at = NOW() WHERE id = $1`, [h.business.id]);
      h.business = await getBusiness(created.id);
      h.state.bookings = initialBookings;
      h.state.inventory = [];
      h.state.conversations = [];
      h.resourceByMockId.clear();
      h.mockIdByResource.clear();
      h.signatures.clear();
      h.flushedInventory.clear();
      h.typeNames.clear();
    },

    sessionToken: (sessionId) => ctx.createSessionToken(h.business.id, sessionId),

    async flushInventory() {
      for (const item of h.state.inventory) {
        if (h.flushedInventory.has(item.id)) continue;
        h.flushedInventory.add(item.id);
        const service = SERVICE_OF[item.category];
        const capacity = item.capacity ?? 4;
        const defaults = service === 'hotel' ? { max_guests: capacity }
          : service === 'restaurant' ? { seating_capacity: capacity, seating_area: item.metadata?.location || 'indoor' }
            : { layouts: [{ name: 'Standard', capacity }] };
        const type = (await query(
          `INSERT INTO resource_types (business_id, service_type, name, defaults) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
          [h.business.id, service, h.typeName(service, item), JSON.stringify(defaults)])).rows[0];
        const quantity = item.quantity || 1;
        for (let unit = 1; unit <= quantity; unit += 1) {
          const resource = (await query(
            `INSERT INTO resources (business_id, service_type, resource_type_id, code, name) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [h.business.id, service, type.id, quantity > 1 ? `${item.code}-${unit}` : item.code, item.name || ''])).rows[0];
          h.resourceByMockId.set(item.id * 1000 + unit, Number(resource.id));
          h.mockIdByResource.set(Number(resource.id), item.id * 1000 + unit);
        }
      }
    },

    typeName(service, item) {
      const wanted = item.name || item.code;
      const key = `${service}:${wanted.toLowerCase()}`;
      const taken = h.typeNames.has(key);
      h.typeNames.add(key);
      return taken ? `${wanted} [${item.code}]` : wanted;
    },

    resourceFor(row) {
      const raw = row[FK_OF[row.service_type]] ?? row.inventory_id ?? null;
      if (raw == null) return null;
      return h.resourceByMockId.get(raw >= 1000 ? raw : raw * 1000 + 1) || null;
    },

    values(row) {
      return COLUMNS.map((column) => {
        if (column === 'date' || column === 'end_date') return dateKey(row[column]);
        if (column === 'waitlisted') return Boolean(row.waitlisted);
        if (column === 'notes') return row.notes ?? '';
        if (column === 'status') return row.status || 'pending';
        return row[column] ?? null;
      });
    },

    /** Write test-side fixture changes to PostgreSQL. */
    async flush() {
      await h.flushInventory();
      const ids = h.state.bookings.map((row) => row.id);
      await query('DELETE FROM bookings WHERE business_id = $1 AND NOT (id = ANY($2::int[]))', [h.business.id, ids]);
      for (const row of h.state.bookings) {
        const values = h.values(row);
        const resourceId = h.resourceFor(row);
        const signature = JSON.stringify([values, resourceId]);
        if (h.signatures.get(row.id) === signature) continue;
        const exists = h.signatures.has(row.id);
        const params = [row.id, h.business.id, ...values, resourceId, row.created_at || new Date(), row.updated_at || new Date()];
        if (!exists) {
          await query(
            `INSERT INTO bookings (id, business_id, ${COLUMNS.join(', ')}, resource_id, created_at, updated_at, channel)
             VALUES ($1, $2, ${COLUMNS.map((_, index) => `$${index + 3}`).join(', ')}, $${COLUMNS.length + 3}, $${COLUMNS.length + 4}, $${COLUMNS.length + 5}, 'legacy')`, params);
        } else {
          await query(
            `UPDATE bookings SET ${COLUMNS.map((column, index) => `${column} = $${index + 3}`).join(', ')}, resource_id = $${COLUMNS.length + 3}
             WHERE id = $1 AND business_id = $2`, params.slice(0, COLUMNS.length + 3));
        }
        // Derive the instants and hold the way the migration does.
        await query(
          `UPDATE bookings b SET
             resource_type_id = (SELECT resource_type_id FROM resources WHERE id = b.resource_id),
             starts_at = CASE WHEN b.date IS NULL THEN NULL WHEN b.service_type = 'hotel' THEN (b.date + TIME '14:00') AT TIME ZONE $2
                              WHEN b.start_time IS NULL THEN NULL ELSE (b.date + b.start_time) AT TIME ZONE $2 END,
             ends_at = CASE WHEN b.date IS NULL THEN NULL WHEN b.service_type = 'hotel' THEN (COALESCE(b.end_date, b.date + 1) + TIME '11:00') AT TIME ZONE $2
                            WHEN b.start_time IS NULL THEN NULL
                            ELSE (b.date + COALESCE(b.end_time, (b.start_time + INTERVAL '1 hour')::time)) AT TIME ZONE $2 END
           WHERE b.id = $1`, [row.id, h.business.timezone]);
        await query(
          `UPDATE bookings SET hold_period = CASE WHEN resource_id IS NOT NULL AND ends_at > starts_at THEN tstzrange(starts_at, ends_at, '[)') END,
                  updated_at = $2 WHERE id = $1`, [row.id, row.updated_at || new Date()]);
      }
      for (const entry of h.state.conversations.filter((item) => !item.__stored)) {
        await query('INSERT INTO conversations (business_id, session_id, role, content) VALUES ($1, $2, $3, $4)',
          [h.business.id, entry.session_id, entry.role, entry.content]);
      }
      await query(`SELECT setval(pg_get_serial_sequence('bookings', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM bookings), 1000))`);
      await h.refresh();
    },

    /** Re-read the rows so assertions see exactly what the database holds. */
    async refresh() {
      const rows = (await query(
        `SELECT id, ${COLUMNS.map((column) => (column === 'date' || column === 'end_date' ? `${column}::text AS ${column}` : column)).join(', ')},
                resource_id, created_at, updated_at
         FROM bookings WHERE business_id = $1 ORDER BY id`, [h.business.id])).rows;
      h.signatures.clear();
      h.state.bookings = rows.map((row) => {
        const shaped = { ...row, resource_id: row.resource_id ? Number(row.resource_id) : null };
        const mockId = shaped.resource_id ? h.mockIdByResource.get(shaped.resource_id) : null;
        if (mockId) shaped[FK_OF[row.service_type]] = mockId;
        h.signatures.set(row.id, JSON.stringify([h.values(shaped), shaped.resource_id]));
        return shaped;
      });
      h.state.conversations = (await query(
        'SELECT session_id, role, content FROM conversations WHERE business_id = $1 ORDER BY id', [h.business.id])).rows
        .map((row) => Object.defineProperty(row, '__stored', { value: true, enumerable: false }));
      return h.state.bookings;
    },

    async snapshot() {
      await h.flush();
      return h.state.bookings.map((row) => ({ ...row }));
    },

    /** supertest with fixtures flushed before, and rows re-read after, every call. */
    request() {
      const agent = supertest(ctx.app);
      const start = (method) => (path) => {
        const steps = [];
        const chain = {
          set(...args) { steps.push(['set', args]); return chain; },
          send(...args) { steps.push(['send', args]); return chain; },
          query(...args) { steps.push(['query', args]); return chain; },
          then(resolve, reject) {
            return (async () => {
              await h.flush();
              let call = agent[method](path).set('X-Business', h.business.slug);
              for (const [name, args] of steps) call = call[name](...args);
              const response = await call;
              await h.refresh();
              return response;
            })().then(resolve, reject);
          },
        };
        return chain;
      };
      return { get: start('get'), post: start('post'), patch: start('patch'), delete: start('delete') };
    },

    seedAlterationInventory() {
      h.state.inventory.push(
        { id: 101, category: 'room', code: 'R101', name: 'Suite', capacity: 20, quantity: 2, metadata: {} },
        { id: 102, category: 'table', code: 'T102', name: 'Large table', capacity: 20, quantity: 2, metadata: {} },
        { id: 103, category: 'meeting', code: 'M103', name: 'Boardroom', capacity: 20, quantity: 2, metadata: {} },
      );
    },

    close: () => pool.end(),
  };
  return h;
}
