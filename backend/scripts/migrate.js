// Versioned, non-destructive migration runner.
//   npm run db:migrate            apply pending migrations
//   npm run db:migrate -- --status   list applied / pending
//   npm run db:migrate -- --report   print the legacy review report only
import 'dotenv/config';
import crypto from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pkg from 'pg';

const { Pool } = pkg;
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const LOCK_KEY = 4827361;

export function listMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort()
    .map((name) => {
      const sql = readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');
      return { version: name.replace(/\.sql$/, ''), sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * @param pool pg Pool
 * @param legacy identity used ONLY when pre-platform data exists:
 *   { timezone, currency, name, slug }
 */
export async function runMigrations(pool, legacy = {}, { log = () => {} } = {}) {
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const done = new Map((await client.query('SELECT version, checksum FROM schema_migrations')).rows
      .map((row) => [row.version, row.checksum]));
    for (const migration of listMigrationFiles()) {
      if (done.has(migration.version)) {
        if (done.get(migration.version) !== migration.checksum) {
          throw new Error(`Migration ${migration.version} was edited after it was applied. Add a new migration instead.`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        for (const [key, value] of Object.entries({
          'app.legacy_timezone': legacy.timezone, 'app.legacy_currency': legacy.currency,
          'app.legacy_name': legacy.name, 'app.legacy_slug': legacy.slug,
        })) {
          await client.query('SELECT set_config($1, $2, true)', [key, value || '']);
        }
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [migration.version, migration.checksum]);
        await client.query('COMMIT');
        applied.push(migration.version);
        log(`applied ${migration.version}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migration.version} failed and was rolled back: ${err.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}

/** Legacy reservations that need a human decision. Nothing is guessed. */
export async function legacyReviewReport(pool) {
  const business = (await pool.query(
    `SELECT id, name, slug, timezone, currency, currency_confirmed, status FROM businesses WHERE is_legacy`)).rows[0];
  if (!business) return { business: null, items: [], blocking: [] };
  const items = (await pool.query(
    `SELECT id, service_type, status, review_reason, reservation_name, date, end_date, start_time, end_time,
            hotel_room_id, table_id, meeting_room_id, resource_id,
            (status IN ('pending','confirmed','modified','checked_in') AND waitlisted = FALSE
              AND (ends_at IS NULL OR ends_at >= NOW()) AND review_reason <> 'legacy_pending_hold') AS blocking
     FROM bookings WHERE business_id = $1 AND review_reason IS NOT NULL ORDER BY id`, [business.id])).rows;
  return { business, items, blocking: items.filter((item) => item.blocking) };
}

function formatReport({ business, items, blocking }) {
  if (!business) return 'No pre-platform data was found; no legacy business was created.';
  const lines = [
    `Legacy business "${business.name}" (public id: ${business.slug}) — timezone ${business.timezone}, ` +
      `currency ${business.currency_confirmed ? business.currency : 'NOT CONFIRMED'}, status ${business.status}.`,
  ];
  if (!business.currency_confirmed) lines.push('ACTION: an owner must confirm the currency before customer booking can be activated.');
  if (!items.length) lines.push('No reservations need review.');
  for (const item of items) {
    lines.push(`  ${item.blocking ? 'BLOCKING' : 'review  '} #${item.id} ${item.service_type} ${item.status} ` +
      `"${item.reservation_name || ''}" ${item.review_reason}`);
  }
  if (blocking.length) lines.push(`${blocking.length} reservation(s) block activation of their service until resolved in Dashboard → Setup → Review.`);
  return lines.join('\n');
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  const requiresSsl = process.env.NODE_ENV === 'production' || process.env.DATABASE_URL.includes('sslmode=');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: requiresSsl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false,
  });
  try {
    const args = process.argv.slice(2);
    if (args.includes('--status')) {
      const exists = (await pool.query(`SELECT to_regclass('schema_migrations') AS t`)).rows[0].t;
      const done = new Set(exists ? (await pool.query('SELECT version FROM schema_migrations')).rows.map((row) => row.version) : []);
      for (const migration of listMigrationFiles()) console.log(`${done.has(migration.version) ? 'applied' : 'PENDING'}  ${migration.version}`);
      return;
    }
    if (!args.includes('--report')) {
      const applied = await runMigrations(pool, {
        timezone: process.env.LEGACY_BUSINESS_TIMEZONE || process.env.CALENDAR_TIMEZONE,
        currency: process.env.LEGACY_BUSINESS_CURRENCY,
        name: process.env.LEGACY_BUSINESS_NAME,
        slug: process.env.LEGACY_BUSINESS_SLUG,
      }, { log: (line) => console.log(line) });
      console.log(applied.length ? `${applied.length} migration(s) applied.` : 'Database is up to date.');
    }
    console.log(formatReport(await legacyReviewReport(pool)));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
