import 'dotenv/config';
import pkg from 'pg';

const { Pool } = pkg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: true },
});

async function migrate() {
    console.log('🔄 Running migration: Renaming check_out_date to end_date...');

    try {
        await pool.query('ALTER TABLE bookings RENAME COLUMN check_out_date TO end_date;');
        console.log('Column renamed successfully!');
    } catch (err) {
        if (err.code === '42703') {
            console.log('Column end_date already exists or check_out_date is missing (already migrated).');
        } else {
            console.error('Migration failed:', err.message);
            throw err;
        }
    } finally {
        await pool.end();
    }
}

migrate().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});
