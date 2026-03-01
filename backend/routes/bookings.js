import express from 'express';
import { query } from '../services/db.js';
import { upsertEvent, cancelEvent } from '../services/googleCalendar.js';

const router = express.Router();

/**
 * GET /api/bookings/:session_id
 * Get all bookings for a session
 */
router.get('/:session_id', async (req, res) => {
    const { session_id } = req.params;
    try {
        const result = await query(
            'SELECT * FROM bookings WHERE session_id = $1 ORDER BY created_at DESC',
            [session_id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('[GET /api/bookings] Error:', err);
        res.status(500).json({ error: 'Failed to fetch bookings.' });
    }
});

/**
 * PATCH /api/bookings/:id
 * Modify a specific booking
 * Body: any subset of { service_type, date, start_time, end_time, people, location, notes, status }
 */
router.patch('/:id', async (req, res) => {
    const { id } = req.params;
    const fields = req.body;
    const allowed = ['service_type', 'date', 'end_date', 'start_time', 'end_time', 'people', 'location', 'notes', 'status'];

    const updates = [];
    const values = [];
    let idx = 1;

    for (const [key, val] of Object.entries(fields)) {
        if (allowed.includes(key)) {
            updates.push(`${key} = $${idx}`);
            values.push(val);
            idx++;
        }
    }

    if (updates.length === 0) {
        return res.status(400).json({ error: 'No valid fields to update.' });
    }

    values.push(id);

    try {
        const result = await query(
            `UPDATE bookings SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
            values
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Booking not found.' });
        }

        // 🔄 Sync with Google Calendar
        const updatedBooking = result.rows[0];
        const eventId = await upsertEvent(updatedBooking);
        if (eventId && eventId !== updatedBooking.google_event_id) {
            await query('UPDATE bookings SET google_event_id = $1 WHERE id = $2', [eventId, updatedBooking.id]);
            updatedBooking.google_event_id = eventId;
        }

        res.json(updatedBooking);
    } catch (err) {
        console.error('[PATCH /api/bookings] Error:', err);
        res.status(500).json({ error: 'Failed to update booking.' });
    }
});

/**
 * DELETE /api/bookings/:id
 * Cancel a booking (sets status = 'cancelled', does not hard-delete)
 */
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await query(
            `UPDATE bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING *`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Booking not found.' });
        }

        // 🔄 Sync with Google Calendar (Delete event if cancelled)
        const cancelledBooking = result.rows[0];
        if (cancelledBooking.google_event_id) {
            await cancelEvent(cancelledBooking.google_event_id);
            await query('UPDATE bookings SET google_event_id = NULL WHERE id = $1', [id]);
        }

        res.json({ success: true, booking: cancelledBooking });
    } catch (err) {
        console.error('[DELETE /api/bookings] Error:', err);
        res.status(500).json({ error: 'Failed to cancel booking.' });
    }
});

export default router;
