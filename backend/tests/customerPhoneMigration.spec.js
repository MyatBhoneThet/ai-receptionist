import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import pkg from 'pg';

const { Pool } = pkg;
const testDatabaseUrl = process.env.CUSTOMER_PHONE_MIGRATION_TEST_DATABASE_URL;
const postgresTests = testDatabaseUrl ? describe : describe.skip;

postgresTests('customer phone PostgreSQL migration', () => {
  let pool;
  let migrationSql;
  let freshCustomerDdl;

  beforeAll(async () => {
    migrationSql = await readFile(
      new URL('../../db/migrations/20261005_customer_phone_number.sql', import.meta.url),
      'utf8'
    );
    const schemaSql = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8');
    freshCustomerDdl = schemaSql.match(/^CREATE TABLE customers \([\s\S]*?^\);/m)?.[0];
    if (!freshCustomerDdl) throw new Error('The standalone customers table DDL was not found.');

    const requiresSsl = process.env.NODE_ENV === 'production' || testDatabaseUrl.includes('sslmode=');
    pool = new Pool({
      connectionString: testDatabaseUrl,
      ssl: requiresSsl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false,
      max: 1,
      connectionTimeoutMillis: 10000,
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function inIsolatedSchema(assertions) {
    const client = await pool.connect();
    const schemaName = `customer_phone_test_${randomUUID().replaceAll('-', '')}`;
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schemaName}"`);
      await client.query(`SET LOCAL search_path TO "${schemaName}", pg_catalog`);
      await assertions(client);
    } finally {
      try {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }
  }

  async function upsertChatCustomer(client, phoneNumber, name) {
    // Match the customer upsert used by POST /api/chat.
    return client.query(
      `INSERT INTO customers (phone_number, name)
       VALUES ($1, $2)
       ON CONFLICT (phone_number)
       DO UPDATE SET name = COALESCE(customers.name, EXCLUDED.name), updated_at = NOW()
       RETURNING id`,
      [phoneNumber, name]
    );
  }

  async function customerColumns(client) {
    const result = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'customers'
       ORDER BY ordinal_position`
    );
    return result.rows.map((row) => row.column_name);
  }

  it('preserves legacy customer data and uniqueness through repeated migrations', async () => {
    await inIsolatedSchema(async (client) => {
      await client.query(`
        CREATE TABLE customers (
          id SERIAL PRIMARY KEY,
          phone TEXT UNIQUE,
          name TEXT,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      const inserted = await client.query(
        'INSERT INTO customers (phone, name) VALUES ($1, $2) RETURNING id',
        ['+660000000001', 'Synthetic Guest']
      );
      const customerId = inserted.rows[0].id;

      await client.query(migrationSql);
      expect(await customerColumns(client)).toEqual(['id', 'phone_number', 'name', 'updated_at']);
      expect((await client.query('SELECT id, phone_number, name FROM customers')).rows).toEqual([
        { id: customerId, phone_number: '+660000000001', name: 'Synthetic Guest' },
      ]);
      expect((await upsertChatCustomer(client, '+660000000001', 'Replacement Name')).rows[0].id)
        .toBe(customerId);

      await client.query(migrationSql);
      expect((await upsertChatCustomer(client, '+660000000001', 'Another Name')).rows[0].id)
        .toBe(customerId);
      expect((await client.query('SELECT id, phone_number, name FROM customers')).rows).toEqual([
        { id: customerId, phone_number: '+660000000001', name: 'Synthetic Guest' },
      ]);
    });
  }, 30000);

  it('supports chat upserts with fresh canonical DDL and leaves it unchanged', async () => {
    await inIsolatedSchema(async (client) => {
      // Execute only this table definition, never the schema's DROP statements.
      await client.query(freshCustomerDdl);
      const columnsBefore = await customerColumns(client);
      expect(columnsBefore).toContain('phone_number');
      expect(columnsBefore).not.toContain('phone');

      const first = await upsertChatCustomer(client, '+660000000002', 'Fresh Synthetic Guest');
      await client.query(migrationSql);
      await client.query(migrationSql);
      expect(await customerColumns(client)).toEqual(columnsBefore);
      expect((await upsertChatCustomer(client, '+660000000002', 'Replacement Name')).rows[0].id)
        .toBe(first.rows[0].id);
      expect((await client.query('SELECT id, phone_number, name FROM customers')).rows).toEqual([
        { id: first.rows[0].id, phone_number: '+660000000002', name: 'Fresh Synthetic Guest' },
      ]);
    });
  }, 30000);
});
