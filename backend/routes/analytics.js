import express from 'express';
import { query } from '../services/db.js';
import { requireAdminToken } from '../middleware/auth.js';
import { formatDateKey } from '../services/dateOnly.js';

const router = express.Router();

router.use(requireAdminToken);

function formatDateOnly(value) {
    if (!value) return value;
    return formatDateKey(value);
}

// GET /api/analytics/summary
// Fetches key metrics for the dashboard
router.get('/summary', async (req, res) => {
    try {
        const totalQuery = await query(`SELECT COUNT(*) as count FROM bookings WHERE status != 'cancelled'`);
        const todayQuery = await query(`SELECT COUNT(*) as count FROM bookings WHERE date = CURRENT_DATE AND status != 'cancelled'`);
        const cancellationsQuery = await query(`SELECT COUNT(*) as count FROM bookings WHERE status = 'cancelled'`);
        
        // Group by service type
        const serviceTypeQuery = await query(`
            SELECT service_type, COUNT(*) as count 
            FROM bookings 
            WHERE status != 'cancelled' 
            GROUP BY service_type
        `);
        
        const serviceTypes = {
            restaurant: 0,
            hotel: 0,
            meeting: 0
        };
        
        serviceTypeQuery.rows.forEach(row => {
            serviceTypes[row.service_type] = parseInt(row.count, 10);
        });

        res.json({
            total_bookings: parseInt(totalQuery.rows[0].count, 10),
            today_bookings: parseInt(todayQuery.rows[0].count, 10),
            cancellations: parseInt(cancellationsQuery.rows[0].count, 10),
            by_service: serviceTypes
        });
    } catch (err) {
        console.error('[GET /api/analytics/summary] Error:', err);
        res.status(500).json({ error: 'Failed to fetch analytics summary.' });
    }
});

// GET /api/analytics/timeseries
// Fetches bookings by date for the last 7 days
router.get('/timeseries', async (req, res) => {
    try {
        const result = await query(`
            SELECT date, COUNT(*) as count 
            FROM bookings 
            WHERE status != 'cancelled' 
            AND date >= CURRENT_DATE - INTERVAL '7 days'
            GROUP BY date 
            ORDER BY date ASC
        `);
        
        res.json(result.rows.map(r => ({
            date: formatDateKey(r.date),
            bookings: parseInt(r.count, 10)
        })));
    } catch (err) {
        console.error('[GET /api/analytics/timeseries] Error:', err);
        res.status(500).json({ error: 'Failed to fetch analytics timeseries.' });
    }
});

// GET /api/analytics/recent
// Fetches the most recent 5 bookings for the activity feed
router.get('/recent', async (req, res) => {
    try {
        const result = await query(`
            SELECT id, service_type, reservation_name, date, start_time, people, status, created_at
            FROM bookings
            ORDER BY created_at DESC
            LIMIT 5
        `);
        res.json(result.rows.map((row) => ({
            ...row,
            date: formatDateOnly(row.date),
        })));
    } catch (err) {
        console.error('[GET /api/analytics/recent] Error:', err);
        res.status(500).json({ error: 'Failed to fetch recent bookings.' });
    }
});

export default router;
