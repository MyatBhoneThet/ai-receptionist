// Creates (if needed) and migrates the disposable test database once per run.
import pkg from 'pg';
import { runMigrations } from '../../scripts/migrate.js';

const { Client, Pool } = pkg;

export default async function globalSetup() {
  const url = process.env.TEST_DATABASE_URL || 'postgres://localhost:5432/ai_receptionist_test';
  const target = new URL(url);
  const name = target.pathname.slice(1);
  if (!/test/i.test(name)) throw new Error(`Refusing to prepare "${name}" as a test database.`);

  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  try {
    await client.connect();
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!exists.rows.length) await client.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  } catch (err) {
    throw new Error(`Integration tests need a local PostgreSQL reachable at ${admin.host}: ${err.message}`);
  } finally {
    await client.end().catch(() => {});
  }

  const pool = new Pool({ connectionString: url });
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}
