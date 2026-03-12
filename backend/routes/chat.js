import express from 'express';
import { chat } from '../services/llm.js';
import { validateBookingResponse } from '../validation/bookingSchema.js';
import { query } from '../services/db.js';
import { upsertEvent } from '../services/googleCalendar.js';
import { chatLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

// Apply chat-specific rate limit (20 req / 1 min per IP)
router.use(chatLimiter);

// simple in-memory session state
const sessionState = new Map();

function getTodayFormatted() {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
}

function normalizeDate(input) {
    if (!input) return input;

    return input.replace(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g, (_, d, m, y) => {
        return `${d.padStart(2, '0')}-${m.padStart(2, '0')}-${y}`;
    });
}

function parseDate(ddmmyyyy) {
    if (!ddmmyyyy) return null;
    const [dd, mm, yyyy] = ddmmyyyy.split('-');
    if (!dd || !mm || !yyyy) return null;
    return new Date(`${yyyy}-${mm}-${dd}`);
}

function parseTime(value) {
    if (!value) return null;
    if (/^\d{2}:\d{2}(:\d{2})?$/.test(value)) return value;
    return null;
}

function getRequiredFields(intent, data) {
    switch (intent) {
        case 'book_restaurant':
            return {
                valid: data.date && data.start_time && (data.people || data.people === 0),
                missing: [
                    !data.date && 'date',
                    !data.start_time && 'start_time',
                    (!data.people && data.people !== 0) && 'people',
                    !data.reservation_name && 'reservation name',
                ].filter(Boolean),
            };

        case 'book_hotel':
            return {
                valid: data.date && data.end_time && (data.people || data.people === 0),
                missing: [
                    !data.date && 'check-in date',
                    !data.end_time && 'check-out date',
                    (!data.people && data.people !== 0) && 'guests',
                    !data.reservation_name && 'reservation name',
                ].filter(Boolean),
            };

        case 'book_meeting':
            return {
                valid:
                    data.date &&
                    data.start_time &&
                    data.end_time &&
                    (data.people || data.people === 0) &&
                    data.location,
                missing: [
                    !data.date && 'date',
                    !data.start_time && 'start_time',
                    !data.end_time && 'end_time',
                    (!data.people && data.people !== 0) && 'people',
                    !data.location && 'location',
                    !data.reservation_name && 'reservation name',
                ].filter(Boolean),
            };

        case 'modify_booking':
            return {
                valid: data.date && data.service_type && data.reservation_name,
                missing: [
                    !data.date && 'date',
                    !data.service_type && 'type of reservation',
                    !data.reservation_name && 'reservation name',
                ].filter(Boolean),
            };

        case 'cancel_booking':
        case 'cancel':
            return {
                valid: data.date && data.service_type && data.reservation_name,
                missing: [
                    !data.date && 'date',
                    !data.service_type && 'type of reservation',
                    !data.reservation_name && 'reservation name',
                ].filter(Boolean),
            };

        default:
            return { valid: false, missing: [] };
    }
}

router.post('/', async (req, res) => {
    const { session_id, message } = req.body;

    if (!session_id || !message) {
        return res.status(400).json({ error: 'session_id and message are required' });
    }

    try {
        const historyResult = await query(
            'SELECT role, content FROM conversations WHERE session_id = $1 ORDER BY created_at ASC',
            [session_id]
        );

        const history = historyResult.rows.slice(-4);
        const today = getTodayFormatted();

        // 🧠 LOAD STATE
        let state = sessionState.get(session_id) || {};

        const normalizedMessage = normalizeDate(message);

        const llmResponse = await chat(history, normalizedMessage, today, state);

        const validation = validateBookingResponse(llmResponse);
        const parsed = validation.data;

        // MERGE STATE (CRITICAL FIX)
        state = {
            ...state,
            ...parsed.data,
        };

        // HOTEL FIX (second date = checkout)
        if (state.date && !state.end_time && parsed.data.date && parsed.data.date !== state.date) {
            state.end_time = parsed.data.date;
        }

        sessionState.set(session_id, state);

        await query(
            'INSERT INTO conversations (session_id, role, content) VALUES ($1, $2, $3)',
            [session_id, 'user', message]
        );

        await query(
            'INSERT INTO conversations (session_id, role, content) VALUES ($1, $2, $3)',
            [session_id, 'assistant', parsed.message]
        );

        const { intent } = parsed;
        const data = state;

        const bookableIntents = ['book_restaurant', 'book_hotel', 'book_meeting'];

        if (bookableIntents.includes(intent)) {
            const check = getRequiredFields(intent, data);

            if (!check.valid) {
                const missingText = `I need a bit more info: ${check.missing.join(', ')}`;
                return res.json({
                    ...parsed,
                    message: missingText,
                    speak: missingText,
                    missing_fields: check.missing,
                });
            }

            const parsedDate = parseDate(data.date);
            let parsedEndDate = null;

            let startTime = parseTime(data.start_time);
            let endTime = parseTime(data.end_time);

            if (intent === 'book_hotel') {
                // For hotels, end_time stored in state is actually the checkout DATE string
                parsedEndDate = parseDate(data.end_time);
                startTime = '14:00:00';
                endTime = '11:00:00';
            }

            if (!startTime) startTime = '12:00';
            if (!endTime) {
                const [h, m] = startTime.split(':').map(Number);
                endTime = `${String((h + 1) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            }

            let targetId = state.id;

            // If we don't have a target ID in state, look for a pending one in this session
            if (!targetId) {
                const existing = await query(
                    `SELECT id, google_event_id, status FROM bookings 
                     WHERE session_id = $1 AND status = 'pending'
                     ORDER BY created_at DESC LIMIT 1`,
                    [session_id]
                );
                if (existing.rows.length > 0) {
                    targetId = existing.rows[0].id;
                }
            }

            if (targetId) {
                const updated = await query(
                    `UPDATE bookings SET
                        service_type = $1,
                        date = $2,
                        end_date = $3,
                        start_time = $4,
                        end_time = $5,
                        people = $6,
                        location = $7,
                        notes = $8,
                        reservation_name = $9,
                        status = CASE WHEN status = 'confirmed' THEN 'modified' ELSE status END,
                        updated_at = NOW()
                     WHERE id = $10 RETURNING *`,
                    [
                        data.service_type || (intent.startsWith('book_') ? intent.replace('book_', '') : ''),
                        parsedDate,
                        parsedEndDate,
                        startTime,
                        endTime,
                        data.people,
                        data.location,
                        data.notes,
                        data.reservation_name,
                        targetId,
                    ]
                );
                state = { ...state, ...updated.rows[0] };

                // Premature Sync Removed: confirmation now happens in /confirm
            } else {
                const result = await query(
                    `INSERT INTO bookings 
                    (session_id, service_type, date, end_date, start_time, end_time, people, location, notes, reservation_name, status)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending') RETURNING *`,
                    [
                        session_id,
                        data.service_type || (intent.startsWith('book_') ? intent.replace('book_', '') : ''),
                        parsedDate,
                        parsedEndDate,
                        startTime,
                        endTime,
                        data.people,
                        data.location,
                        data.notes,
                        data.reservation_name,
                    ]
                );

                // 🔄 Premature Sync Removed: confirmation now happens in /confirm
            }
        } else if (intent === 'modify_booking') {
            const check = {
                valid: data.date && data.service_type && data.reservation_name,
                missing: [
                    !data.date && 'date',
                    !data.service_type && 'type of reservation',
                    !data.reservation_name && 'reservation name',
                ].filter(Boolean),
            };

            if (!check.valid) {
                const missingText = `To find your booking, I'll need a few details: ${check.missing.join(', ')}`;
                return res.json({
                    ...parsed,
                    message: missingText,
                    speak: missingText,
                    missing_fields: check.missing,
                });
            }

            const parsedDate = parseDate(data.date);
            const serviceType = data.service_type.toLowerCase().trim();
            const reservationName = data.reservation_name.toLowerCase().trim();

            const existing = await query(
                `SELECT * FROM bookings 
                 WHERE date = $1 
                 AND service_type = $2 
                 AND LOWER(reservation_name) = $3
                 AND status IN ('pending', 'confirmed', 'modified')
                 ORDER BY created_at DESC LIMIT 1`,
                [parsedDate, serviceType, reservationName]
            );

            if (existing.rows.length > 0) {
                const booking = existing.rows[0];
                state = { ...state, ...booking };
                sessionState.set(session_id, state);

                const msg = `I've found your ${booking.service_type} reservation for ${data.date} under the name "${booking.reservation_name}". What would you like to change?`;
                return res.json({
                    ...parsed,
                    message: msg,
                    speak: msg,
                    data: state
                });
            } else {
                const msg = `I couldn't find a ${data.service_type} reservation for ${data.date} under the name "${data.reservation_name}". Could you double-check the details?`;
                return res.json({
                    ...parsed,
                    message: msg,
                    speak: msg,
                    data: state
                });
            }
        } else if (intent === 'cancel_booking' || intent === 'cancel') {
            const check = {
                valid: data.date && data.service_type && data.reservation_name,
                missing: [
                    !data.date && 'date',
                    !data.service_type && 'type of reservation',
                    !data.reservation_name && 'reservation name',
                ].filter(Boolean),
            };

            if (!check.valid) {
                const missingText = `To find your booking, I'll need a few details: ${check.missing.join(', ')}`;
                return res.json({
                    ...parsed,
                    message: missingText,
                    speak: missingText,
                    missing_fields: check.missing,
                });
            }

            const parsedDate = parseDate(data.date);
            const serviceType = data.service_type.toLowerCase().trim();
            const reservationName = data.reservation_name.toLowerCase().trim();

            const existing = await query(
                `SELECT * FROM bookings 
                 WHERE date = $1 
                 AND service_type = $2 
                 AND LOWER(reservation_name) = $3
                 AND status IN ('pending', 'confirmed', 'modified')
                 ORDER BY created_at DESC LIMIT 1`,
                [parsedDate, serviceType, reservationName]
            );

            if (existing.rows.length > 0) {
                const booking = existing.rows[0];
                // Return found booking data so frontend can show summary
                state = { ...state, ...booking };
                sessionState.set(session_id, state);

                const msg = `I've found your ${booking.service_type} reservation for ${data.date} under the name "${booking.reservation_name}". Would you like to proceed with the cancellation?`;
                return res.json({
                    ...parsed,
                    message: msg,
                    speak: msg,
                    data: state,
                    show_cancel_confirm: true // New flag for frontend
                });
            } else {
                const msg = `I'm so sorry, but I couldn't find a ${data.service_type} reservation for ${data.date} under the name "${data.reservation_name}". Could you double-check the details for me?`;
                return res.json({
                    ...parsed,
                    message: msg,
                    speak: msg,
                    data: state
                });
            }
        }

        return res.json({
            ...parsed,
            data: state, // always return merged state
        });

    } catch (err) {
        console.error('[POST /api/chat] Error:', err);
        return res.status(500).json({ error: 'Something went wrong.' });
    }
});

// POST /api/chat/confirm(Finalize the most recent pending booking for this session)
router.post('/confirm', async (req, res) => {
    const { session_id, action } = req.body;

    if (!session_id) {
        return res.status(400).json({ error: 'session_id is required' });
    }

    try {
        // Find the latest active booking
        const latest = await query(
            `SELECT id, status FROM bookings 
             WHERE session_id = $1 AND status IN ('pending', 'confirmed', 'modified')
             ORDER BY created_at DESC LIMIT 1`,
            [session_id]
        );

        if (latest.rows.length === 0) {
            return res.json({ success: false, message: 'No active booking found.' });
        }

        const bookingId = latest.rows[0].id;
        const currentStatus = latest.rows[0].status;

        // Determine target status
        let targetStatus = 'confirmed';
        if (action === 'cancel') {
            targetStatus = 'cancelled';
        } else if (currentStatus === 'confirmed') {
            // Already confirmed, no need to update status unless it was 'modified'
            return res.json({ success: true, booking_id: bookingId, message: 'Already confirmed.' });
        }

        const result = await query(
            `UPDATE bookings SET status = 'confirmed', updated_at = NOW() WHERE id = $1 RETURNING *`,
            [bookingId]
        );

        if (result.rows.length === 0) {
            return res.json({ success: false, message: 'No pending booking found to confirm.' });
        }

        const confirmedBooking = result.rows[0];

        // Final Sync with Google Calendar on explicit confirmation
        try {
            if (confirmedBooking.status === 'confirmed') {
                const eventId = await upsertEvent(confirmedBooking);
                if (eventId) {
                    await query('UPDATE bookings SET google_event_id = $1 WHERE id = $2', [eventId, confirmedBooking.id]);
                }
            } else if (confirmedBooking.status === 'cancelled') {
                if (confirmedBooking.google_event_id) {
                    const { cancelEvent } = await import('../services/googleCalendar.js');
                    await cancelEvent(confirmedBooking.google_event_id);
                    await query('UPDATE bookings SET google_event_id = NULL WHERE id = $2', [confirmedBooking.id]);
                }
            }
        } catch (syncErr) {
            console.error('[POST /api/chat/confirm] Calendar Sync Error:', syncErr);
            // We still consider the booking confirmed in our DB even if calendar fails
        }

        return res.json({ success: true, booking_id: confirmedBooking.id });
    } catch (err) {
        console.error('[POST /api/chat/confirm] Error:', err);
        return res.status(500).json({ error: 'Something went wrong.' });
    }
});

export default router;