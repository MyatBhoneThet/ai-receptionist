import pkg from 'pg';
import 'dotenv/config';

const { Pool } = pkg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL + '?sslmode=verify-full',
    ssl: {
        rejectUnauthorized: true,
    },
});

pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL client error', err);
});

export async function query(text, params) {
    const start = Date.now();
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log(`[DB] query="${text.slice(0, 60)}..." duration=${duration}ms rows=${res.rowCount}`);
    return res;
}

export default pool;