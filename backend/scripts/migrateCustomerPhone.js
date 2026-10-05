import 'dotenv/config';
import { readFile } from 'fs/promises';
import pkg from 'pg';

const { Pool } = pkg;

const isProduction = process.env.NODE_ENV === 'production';
const requiresSsl = process.env.DATABASE_URL?.includes('sslmode=');
const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction || requiresSsl ? { rejectUnauthorized } : false,
});

async function migrate() {
  let client;
  try {
    const sql = await readFile(
      new URL('../../db/migrations/20261005_customer_phone_number.sql', import.meta.url),
      'utf8'
    );
    client = await pool.connect();
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
      console.log('Customer phone migration completed successfully.');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    client?.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Customer phone migration failed:', err.message);
  process.exitCode = 1;
});
