import pkg from 'pg';
import 'dotenv/config';

const { Pool } = pkg;

const isProduction = process.env.NODE_ENV === 'production';
const requiresSsl = process.env.DATABASE_URL?.includes('sslmode=');
const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction || requiresSsl
        ? { rejectUnauthorized }
        : false,
});

const logQueries = process.env.DB_QUERY_LOGGING === 'true';

// Handle unexpected idle client errors
pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL client error', err);
});

// Reusable query function
export async function query(text, params) {
    const start = Date.now();
    try {
        const res = await pool.query(text, params);
        const duration = Date.now() - start;

        if (logQueries) {
            console.log(`[DB] duration=${duration}ms rows=${res.rowCount}`);
        }

        return res;
    } catch (err) {
        console.error('[DB ERROR]', err.message);
        throw err;
    }
}

export default pool;

/** Run `fn` inside one transaction on one connection. Rolls back on any error. */
export async function withTransaction(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
        throw err;
    } finally {
        client.release();
    }
}
