import 'dotenv/config';
import pkg from 'pg';

const { Pool } = pkg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: true },
});

async function addColumn() {
    console.log('🔄 Adding missing end_date column to bookings table...');

    try {
        await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS end_date DATE;');
        console.log('✅ Column end_date added successfully!');
    } catch (err) {
        console.error('❌ Failed to add column:', err.message);
        throw err;
    } finally {
        await pool.end();
    }
}

addColumn().catch((err) => {
    console.error('❌ Action failed:', err);
    process.exit(1);
});
