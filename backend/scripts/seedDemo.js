// Creates a DEMO business for local development and demonstrations:
//   • restaurant tables and meeting rooms managed in this dashboard (internal)
//   • hotel rooms sourced from the MOCK external provider
// Refuses to run in production. Safe to run more than once.
//   npm run demo:seed -- --email you@example.com --password "choose-one"
import 'dotenv/config';
import pool, { query } from '../services/db.js';
import { createUser, findUserByEmail } from '../services/auth.js';
import { createBusiness, getBusiness, getBusinessBySlug, updateService, setBusinessStatus } from '../platform/businesses.js';
import { createType, createBatch } from '../platform/inventory.js';
import { createIntegration, testIntegration, importInventory } from '../platform/integrations.js';
import { seedMockInventory } from '../booking/providers/mockPms.js';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('The demo seed never runs in production.');
  const email = arg('email').toLowerCase();
  const password = arg('password');
  const slug = arg('slug', 'demo-hotel');
  if (!email) throw new Error('Usage: npm run demo:seed -- --email <email> [--password <for a new account>] [--slug demo-hotel]');
  if (await getBusinessBySlug(slug)) { console.log(`A business with public id "${slug}" already exists; nothing to do.`); return; }

  let user = await findUserByEmail(email);
  if (!user) {
    if (password.length < 8) throw new Error('That account does not exist yet. Pass --password (8+ characters) to create it.');
    user = await createUser({ email, password, name: 'Demo Owner' });
  }
  const actor = { email: user.email, userId: user.id };
  const created = await createBusiness(user, { name: 'Demo Grand Hotel', slug, timezone: 'Asia/Bangkok', currency: 'THB',
    contact_email: email, services: [
      { service_type: 'restaurant', enabled: true, booking_source: 'internal' },
      { service_type: 'meeting', enabled: true, booking_source: 'internal' },
      { service_type: 'hotel', enabled: true, booking_source: 'external' },
    ] });
  const business = await getBusiness(created.id);

  await updateService(business, 'restaurant', { settings: { default_duration_minutes: 90, turnover_buffer_minutes: 15,
    operating_hours: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [day, [{ open: '11:00', close: '23:00' }]])) } }, actor);
  const indoor = await createType(business, { service_type: 'restaurant', name: 'Standard indoor table', code_prefix: 'T',
    defaults: { seating_capacity: 4, seating_area: 'indoor' } }, actor);
  await createBatch(business, { resource_type_id: indoor.id, quantity: 10, prefix: 'T', start_number: 1, pad: 2 }, actor);
  const priv = await createType(business, { service_type: 'restaurant', name: 'Private table', code_prefix: 'P',
    defaults: { seating_capacity: 8, seating_area: 'private', min_spend: '3000', deposit: { type: 'fixed', amount: '500' } } }, actor);
  await createBatch(business, { resource_type_id: priv.id, quantity: 2, prefix: 'P', start_number: 1, pad: 2 }, actor);

  await updateService(business, 'meeting', { settings: { min_duration_minutes: 60, increment_minutes: 30, setup_buffer_minutes: 15, cleanup_buffer_minutes: 15 } }, actor);
  const boardroom = await createType(business, { service_type: 'meeting', name: 'Boardroom', code_prefix: 'M', defaults: { rate_unit: 'hourly', base_rate: '800',
    layouts: [{ name: 'Boardroom', capacity: 12 }, { name: 'Theatre', capacity: 30 }], equipment: ['Projector', 'Video conferencing'] } }, actor);
  await createBatch(business, { resource_type_id: boardroom.id, quantity: 2, prefix: 'M', start_number: 1, pad: 1 }, actor);

  const integration = await createIntegration(business, { provider_key: 'mock', name: 'Demo PMS (mock)' }, actor);
  await seedMockInventory(integration.id, [
    { service_type: 'hotel', external_id: 'STD', name: 'Standard room', capacity: 2, rate: '1800',
      units: ['101', '102', '103'].map((code) => ({ external_id: `U-${code}`, code })) },
    { service_type: 'hotel', external_id: 'DLX', name: 'Deluxe room', capacity: 3, rate: '2800',
      units: ['201', '202'].map((code) => ({ external_id: `U-${code}`, code })) },
  ]);
  await updateService(business, 'hotel', { booking_source: 'external', integration_id: integration.id }, actor);
  await testIntegration(business, integration.id, actor);
  await importInventory(business, integration.id, actor);
  await setBusinessStatus(await getBusiness(business.id), 'active', actor);

  console.log(`Demo business ready. Public id: ${slug}`);
  console.log(`  Dashboard:   sign in as ${email}`);
  console.log(`  Guest chat:  /?business=${slug}`);
  console.log('  Hotel rooms use the MOCK provider. Set ALLOW_MOCK_PROVIDER_BOOKING=true (never in production) to let guests book them.');
  console.log(`  Webhook signing secret for the mock (shown once): ${integration.webhook_secret_once}`);
  await query('SELECT 1');
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end());
