// Fixtures for real-PostgreSQL integration tests. Everything is disposable.
import bcrypt from 'bcryptjs';
import pool, { query } from '../../services/db.js';
import { createBusiness, getBusiness, updateService, setBusinessStatus } from '../../platform/businesses.js';
import { createType, createBatch } from '../../platform/inventory.js';

const TABLES = ['mock_pms_events', 'mock_pms_reservations', 'mock_pms_units', 'mock_pms_room_types', 'mock_pms_accounts',
  'sync_events', 'sync_jobs', 'external_mappings', 'booking_commands', 'operational_events', 'maintenance_blocks', 'closures',
  'chat_sessions', 'conversations', 'audit_logs', 'app_settings', 'bookings', 'resources', 'resource_types', 'customers',
  'business_services', 'integrations', 'business_memberships', 'businesses', 'users',
  'hotel_rooms', 'restaurant_tables', 'meeting_rooms'];

export async function resetDb() {
  if (!/test/i.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('resetDb is only allowed on a test database.');
  await query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

export async function closeDb() {
  await pool.end();
}

const PASSWORD_HASH = bcrypt.hashSync('correct-horse-battery', 4);
let userCounter = 0;

export async function makeUser(email, role = 'customer') {
  userCounter += 1;
  const row = (await query(
    `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4) RETURNING id, email, role`,
    [email || `user${userCounter}@example.test`, PASSWORD_HASH, 'Test User', role])).rows[0];
  return { ...row, password: 'correct-horse-battery' };
}

export const actorOf = (user) => ({ email: user.email, userId: user.id });

/**
 * A business with internally managed services, e.g.
 *   makeBusiness({ slug: 'alpha', hotel: { settings: {...}, types: [{ name: 'Standard', defaults: {...}, codes: ['101', '102'] }] } })
 */
export async function makeBusiness({ slug, name, timezone = 'Asia/Bangkok', currency = 'THB', owner, activate = true, ...services } = {}) {
  const user = owner || await makeUser(`${slug}-owner@example.test`);
  const actor = actorOf(user);
  const created = await createBusiness(user, {
    name: name || `Business ${slug}`, slug, timezone, currency,
    services: Object.keys(services).map((service_type) => ({ service_type, enabled: true, booking_source: 'internal' })),
  });
  const business = await getBusiness(created.id);
  const resources = {};
  const types = {};
  for (const [serviceType, config] of Object.entries(services)) {
    if (config.settings) await updateService(business, serviceType, { settings: config.settings }, actor);
    for (const type of config.types || []) {
      const createdType = await createType(business, { service_type: serviceType, name: type.name, defaults: type.defaults || {} }, actor);
      types[type.name] = createdType;
      for (const item of await createBatch(business, { resource_type_id: createdType.id, codes: type.codes }, actor)) {
        resources[item.code] = item.id;
      }
    }
  }
  if (activate) await setBusinessStatus(business, 'active', actor);
  return { business: await getBusiness(created.id), owner: user, actor, resources, types };
}

let keyCounter = 0;
export const idem = (label = 'k') => `test-${label}-${Date.now()}-${keyCounter += 1}`;

export async function bookingRow(id) {
  return (await query('SELECT * FROM bookings WHERE id = $1', [id])).rows[0];
}
