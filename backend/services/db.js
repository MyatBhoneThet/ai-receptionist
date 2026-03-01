import pkg from 'pg';
import 'dotenv/config';

const { Pool } = pkg;

const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction
        ? { rejectUnauthorized: false }
        : false,
});

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

        console.log(
            `[DB] query="${text.slice(0, 60)}..." duration=${duration}ms rows=${res.rowCount}`
        );

        return res;
    } catch (err) {
        console.error('[DB ERROR]', err.message);
        throw err;
    }
}

export default pool;