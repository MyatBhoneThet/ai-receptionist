import express from 'express';
import { query } from '../services/db.js';
import { upsertEvent, cancelEvent, getEventStatus, isCalendarSyncEnabled } from '../services/googleCalendar.js';
import { bookingsLimiter } from '../middleware/rateLimiter.js';
import { requireAdminToken, requireSessionToken } from '../middleware/auth.js';
import { notifyBooking } from '../services/notifications.js';
import { checkAvailability } from '../services/availability.js';
import { recordAuditLog } from '../services/appSettings.js';
import { formatDateKey } from '../services/dateOnly.js';

const router = express.Router();

// Apply bookings-specific rate limit (30 req / 1 min per IP)
router.use(bookingsLimiter);

// ── Helpers ──────────────────────────────────────────────────────────────

function serializeDateValue(value) {
    return formatDateKey(value);
}

function serializeBooking(booking) {
    if (!booking) return booking;
    return {
        ...booking,
        date:     serializeDateValue(booking.date),
        end_date: serializeDateValue(booking.end_date),
    };
}

/**
 * SELECT bookings with the resource joined so responses always include
 * the human-readable room number / table number / room name.
 */
const BOOKING_SELECT = `
  SELECT
    b.*,
    -- Hotel room details
    hr.room_number,
    hr.room_type,
    hr.floor        AS room_floor,
    hr.price_per_night,
    -- Restaurant table details
    rt.table_number,
    rt.location     AS table_location,
    -- Meeting room details
    mr.room_name,
    mr.room_code
  FROM bookings b
  LEFT JOIN hotel_rooms       hr ON b.hotel_room_id   = hr.id
  LEFT JOIN restaurant_tables rt ON b.table_id        = rt.id
  LEFT JOIN meeting_rooms     mr ON b.meeting_room_id = mr.id
`;

// ── Waitlist promotion ────────────────────────────────────────────────────

export async function promoteWaitlist({ service_type, date }) {
    try {
        const avail = await checkAvailability({ service_type, date });
        if (avail.waitlist) return null;
        const next = await query(
            `SELECT * FROM bookings
             WHERE service_type = $1 AND date = $2 AND waitlisted = TRUE
             ORDER BY created_at ASC LIMIT 1`,
            [service_type, date]
        );
        if (next.rows.length === 0) return null;
        const b = next.rows[0];
        const updated = await query(
            `UPDATE bookings SET waitlisted = FALSE, updated_at = NOW() WHERE id = $1 RETURNING *`,
            [b.id]
        );
        const booking = updated.rows[0];
        await notifyBooking({
            type:    'waitlist_open',
            toEmail: booking.contact_email,
            toPhone: booking.contact_phone,
            booking,
            isVip:   false,
        });
        return booking;
    } catch (err) {
        console.error('[promoteWaitlist]', err);
        return null;
    }
}

async function cancelCalendarEventForBooking(booking) {
    if (!booking?.google_event_id) return false;
    const deleted = await cancelEvent(booking.google_event_id);
    if (deleted) {
        await query('UPDATE bookings SET google_event_id = NULL WHERE id = $1', [booking.id]);
        booking.google_event_id = null;
    }
    return deleted;
}

async function syncDeletedCalendarEvents(limit = 100) {
    const result = await query(
        `SELECT * FROM bookings
         WHERE google_event_id IS NOT NULL
           AND status != 'cancelled'
         ORDER BY updated_at DESC
         LIMIT $1`,
        [Math.min(Number(limit) || 100, 500)]
    );

    const synced = [];
    const errors = [];

    for (const row of result.rows) {
        const status = await getEventStatus(row.google_event_id);
        if (status.available === false && ['missing', 'cancelled'].includes(status.reason)) {
            const updated = await query(
                `UPDATE bookings
                 SET status = 'cancelled', google_event_id = NULL, updated_at = NOW()
                 WHERE id = $1
                 RETURNING *`,
                [row.id]
            );
            const booking = serializeBooking(updated.rows[0]);
            synced.push({ id: booking.id, status: booking.status, reason: status.reason });
            await promoteWaitlist({ service_type: booking.service_type, date: booking.date });
        } else if (status.available === null) {
            errors.push({ id: row.id, google_event_id: row.google_event_id, error: status.error || status.reason });
        }
    }

    return { checked: result.rows.length, synced, errors };
}

// ── Routes ────────────────────────────────────────────────────────────────

// POST /api/bookings/sync-calendar
router.post('/sync-calendar', requireAdminToken, async (req, res) => {
    try {
        const result = await syncDeletedCalendarEvents(req.body?.limit);
        return res.json(result);
    } catch (err) {
        console.error('[POST /api/bookings/sync-calendar] Error:', err);
        return res.status(500).json({ error: 'Failed to sync calendar deletions.' });
    }
});

// GET /api/bookings/:session_id  — fetch all bookings for a session (includes resource info)
router.get('/:session_id', requireSessionToken, async (req, res) => {
    const { session_id } = req.params;
    try {
        const result = await query(
            `${BOOKING_SELECT}
             WHERE b.session_id = $1
             ORDER BY b.created_at DESC`,
            [session_id]
        );
        res.json(result.rows.map(serializeBooking));
    } catch (err) {
        console.error('[GET /api/bookings] Error:', err);
        res.status(500).json({ error: 'Failed to fetch bookings.' });
    }
});

// GET /api/bookings  — Admin: list all bookings (includes resource info)
router.get('/', requireAdminToken, async (req, res) => {
    const { status, limit = 50, service_type } = req.query;
    const clauses = [];
    const values  = [];

    if (status)       { clauses.push(`b.status = $${values.length + 1}`);       values.push(status); }
    if (service_type) { clauses.push(`b.service_type = $${values.length + 1}`); values.push(service_type); }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    values.push(Math.min(Number(limit) || 50, 200));

    try {
        const result = await query(
            `${BOOKING_SELECT}
             ${where}
             ORDER BY b.created_at DESC
             LIMIT $${values.length}`,
            values
        );
        res.json(result.rows.map(serializeBooking));
    } catch (err) {
        console.error('[GET /api/bookings admin] Error:', err);
        res.status(500).json({ error: 'Failed to fetch bookings.' });
    }
});

// PATCH /api/bookings/:id  — Admin: modify a booking
router.patch('/:id', requireAdminToken, async (req, res) => {
    const { id }   = req.params;
    const fields   = req.body;
    const allowed  = [
        'service_type', 'date', 'end_date', 'start_time', 'end_time',
        'people', 'notes', 'status', 'reservation_name', 'waitlisted',
        'hotel_room_id', 'table_id', 'meeting_room_id',
        'contact_email', 'contact_phone',
    ];

    const updates = [];
    const values  = [];
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
        const beforeResult = await query('SELECT * FROM bookings WHERE id = $1', [id]);
        const beforeState  = beforeResult.rows[0] || {};
        const result = await query(
            `UPDATE bookings SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
            values
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Booking not found.' });
        }

        const rawBooking = result.rows[0];
        const updatedBooking = serializeBooking(rawBooking);
        let calendarSync;
        if (updatedBooking.status === 'cancelled') {
            await cancelCalendarEventForBooking(updatedBooking);
            await promoteWaitlist({ service_type: updatedBooking.service_type, date: updatedBooking.date });
        } else {
            const eventId = await upsertEvent(rawBooking);
            calendarSync = { status: eventId ? 'synced' : (isCalendarSyncEnabled() ? 'failed' : 'disabled') };
            if (eventId && eventId !== updatedBooking.google_event_id) {
                await query('UPDATE bookings SET google_event_id = $1 WHERE id = $2', [eventId, updatedBooking.id]);
                updatedBooking.google_event_id = eventId;
            }
        }

        try {
            if (updatedBooking.status === 'confirmed') {
                await notifyBooking({ type: 'confirm', toEmail: updatedBooking.contact_email, toPhone: updatedBooking.contact_phone, booking: updatedBooking });
            } else if (updatedBooking.status === 'cancelled') {
                await notifyBooking({ type: 'cancel',   toEmail: updatedBooking.contact_email, toPhone: updatedBooking.contact_phone, booking: updatedBooking });
            }
        } catch (notifyErr) {
            console.error('[PATCH /api/bookings] Notification error:', notifyErr);
        }

        await recordAuditLog({
            actorEmail:  req.user?.email || 'admin',
            action:      'update',
            entity:      'booking',
            entity_id:   Number(id),
            beforeState,
            afterState:  updatedBooking,
        });

        res.json({ ...updatedBooking, ...(calendarSync ? { calendar_sync: calendarSync } : {}) });
    } catch (err) {
        console.error('[PATCH /api/bookings] Error:', err);
        res.status(500).json({ error: 'Failed to update booking.' });
    }
});

// DELETE /api/bookings/:id  — Admin: cancel a booking
router.delete('/:id', requireAdminToken, async (req, res) => {
    const { id } = req.params;
    try {
        const beforeResult = await query('SELECT * FROM bookings WHERE id = $1', [id]);
        const beforeState  = beforeResult.rows[0] || {};
        const result = await query(
            `UPDATE bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING *`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Booking not found.' });
        }

        const cancelledBooking = serializeBooking(result.rows[0]);
        await cancelCalendarEventForBooking(cancelledBooking);
        await promoteWaitlist({ service_type: cancelledBooking.service_type, date: cancelledBooking.date });

        await recordAuditLog({
            actorEmail:  req.user?.email || 'admin',
            action:      'cancel',
            entity:      'booking',
            entity_id:   Number(id),
            beforeState,
            afterState:  cancelledBooking,
        });

        res.json({ success: true, booking: cancelledBooking });
    } catch (err) {
        console.error('[DELETE /api/bookings] Error:', err);
        res.status(500).json({ error: 'Failed to cancel booking.' });
    }
});

// POST /api/bookings/:id/status  — Admin: status transitions
router.post('/:id/status', requireAdminToken, async (req, res) => {
    const { id }     = req.params;
    const { status } = req.body;
    const allowedStatuses = ['pending', 'confirmed', 'modified', 'cancelled', 'checked_in', 'no_show'];
    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    try {
        const beforeResult = await query('SELECT * FROM bookings WHERE id = $1', [id]);
        const beforeState  = beforeResult.rows[0] || {};
        const result = await query(
            `UPDATE bookings SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
            [status, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Booking not found.' });
        }
        const rawBooking = result.rows[0];
        const booking = serializeBooking(rawBooking);
        let calendarSync;
        if (status === 'cancelled') {
            await cancelCalendarEventForBooking(booking);
            await promoteWaitlist({ service_type: booking.service_type, date: booking.date });
        } else if (status === 'confirmed' || status === 'modified') {
            const eventId = await upsertEvent(rawBooking);
            calendarSync = { status: eventId ? 'synced' : (isCalendarSyncEnabled() ? 'failed' : 'disabled') };
            if (eventId && eventId !== booking.google_event_id) {
                await query('UPDATE bookings SET google_event_id = $1 WHERE id = $2', [eventId, booking.id]);
                booking.google_event_id = eventId;
            }
        }
        await recordAuditLog({
            actorEmail:  req.user?.email || 'admin',
            action:      'status_change',
            entity:      'booking',
            entity_id:   Number(id),
            beforeState,
            afterState:  booking,
        });
        return res.json({ ...booking, ...(calendarSync ? { calendar_sync: calendarSync } : {}) });
    } catch (err) {
        console.error('[POST /api/bookings/:id/status] Error:', err);
        return res.status(500).json({ error: 'Failed to update status.' });
    }
});

// POST /api/bookings/availability/check
router.post('/availability/check', async (req, res) => {
    const { service_type, date, end_date, start_time, end_time, people, exclude_booking_id } = req.body || {};
    if (!service_type || !date) {
        return res.status(400).json({ error: 'service_type and date are required' });
    }
    try {
        const result = await checkAvailability({ service_type, date, end_date, start_time, end_time, people, exclude_booking_id });
        return res.json(result);
    } catch (err) {
        console.error('[POST /api/bookings/availability/check] Error:', err);
        return res.status(500).json({ error: 'Failed to check availability' });
    }
});

export default router;
