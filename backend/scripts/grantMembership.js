// Give an existing account access to a business.
//   npm run business:grant -- --email owner@example.com --business lumiere --role owner
// Use this to appoint the first owner of the migrated legacy business when no
// existing admin account was available to inherit it.
import 'dotenv/config';
import pool, { query } from '../services/db.js';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? '' : process.argv[index + 1] || '';
}

async function main() {
  const email = arg('email').toLowerCase();
  const slug = arg('business').toLowerCase();
  const role = arg('role') || 'staff';
  if (!email || !slug || !['owner', 'admin', 'staff'].includes(role)) {
    throw new Error('Usage: npm run business:grant -- --email <email> --business <public id> --role owner|admin|staff');
  }
  const user = (await query('SELECT id FROM users WHERE email = $1', [email])).rows[0];
  if (!user) throw new Error(`No account exists for ${email}. Register it first.`);
  const business = (await query('SELECT id, name FROM businesses WHERE slug = $1', [slug])).rows[0];
  if (!business) throw new Error(`No business has the public id "${slug}".`);
  await query(
    `INSERT INTO business_memberships (business_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (business_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [business.id, user.id, role]);
  await query(
    `INSERT INTO audit_logs (business_id, actor_email, action, entity, after_state) VALUES ($1, 'cli', 'grant', 'membership', $2::jsonb)`,
    [business.id, JSON.stringify({ email, role })]);
  console.log(`${email} is now ${role} of ${business.name}.`);
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end());
