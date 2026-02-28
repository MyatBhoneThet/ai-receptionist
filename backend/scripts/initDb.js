import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pkg from 'pg';

const { Pool } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: true },
});

async function initDb() {
    const schemaPath = join(__dirname, '../../db/schema.sql');
    const sql = readFileSync(schemaPath, 'utf-8');

    console.log('🔄 Initializing database...');
    await pool.query(sql);
    console.log('✅ Database initialized successfully!');
    await pool.end();
}

initDb().catch((err) => {
    console.error('❌ Database initialization failed:', err);
    process.exit(1);
});
