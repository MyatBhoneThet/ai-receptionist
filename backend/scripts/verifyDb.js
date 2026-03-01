import 'dotenv/config';
import pkg from 'pg';

const { Pool } = pkg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: true },
});

async function verify() {
    try {
        const res = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'bookings';");
        console.log('Columns in bookings table:');
        res.rows.forEach(row => console.log(`- ${row.column_name}`));
    } catch (err) {
        console.error('❌ Verification failed:', err.message);
    } finally {
        await pool.end();
    }
}

verify();
