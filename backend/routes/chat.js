import express from 'express';
import { chat } from '../services/llm.js';
import { validateBookingResponse } from '../validation/bookingSchema.js';
import { query } from '../services/db.js';

const router = express.Router();

// 🧠 simple in-memory session state
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
                ].filter(Boolean),
            };

        case 'book_hotel':
            return {
                valid: data.date && data.end_time && (data.people || data.people === 0),
                missing: [
                    !data.date && 'check-in date',
                    !data.end_time && 'check-out date',
                    (!data.people && data.people !== 0) && 'guests',
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

        const history = historyResult.rows;
        const today = getTodayFormatted();

        // 🧠 LOAD STATE
        let state = sessionState.get(session_id) || {};

        const normalizedMessage = normalizeDate(message);

        const llmResponse = await chat(history, normalizedMessage, today, state);

        const validation = validateBookingResponse(llmResponse);
        const parsed = validation.data;

        // 🧠 MERGE STATE (CRITICAL FIX)
        state = {
            ...state,
            ...parsed.data,
        };

        // 🧠 HOTEL FIX (second date = checkout)
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
                return res.json({
                    ...parsed,
                    message: `I need a bit more info: ${check.missing.join(', ')}`,
                    speak: `Need ${check.missing[0]}`,
                    missing_fields: check.missing,
                });
            }

            const parsedDate = parseDate(data.date);

            let startTime = parseTime(data.start_time);
            let endTime = parseTime(data.end_time);

            if (intent === 'book_hotel') {
                startTime = '14:00';
                endTime = '11:00';
            }

            if (!startTime) startTime = '12:00';
            if (!endTime) endTime = '13:00';

            const existing = await query(
                `SELECT id FROM bookings 
                 WHERE session_id = $1 AND status = 'pending' 
                 ORDER BY created_at DESC LIMIT 1`,
                [session_id]
            );

            if (existing.rows.length > 0) {
                await query(
                    `UPDATE bookings SET
                        service_type = $1,
                        date = $2,
                        start_time = $3,
                        end_time = $4,
                        people = $5,
                        location = $6,
                        notes = $7,
                        updated_at = NOW()
                     WHERE id = $8`,
                    [
                        data.service_type,
                        parsedDate,
                        startTime,
                        endTime,
                        data.people,
                        data.location,
                        data.notes,
                        existing.rows[0].id,
                    ]
                );
            } else {
                await query(
                    `INSERT INTO bookings 
                    (session_id, service_type, date, start_time, end_time, people, location, notes)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [
                        session_id,
                        data.service_type,
                        parsedDate,
                        startTime,
                        endTime,
                        data.people,
                        data.location,
                        data.notes,
                    ]
                );
            }
        }

        return res.json({
            ...parsed,
            data: state, // ✅ always return merged state
        });

    } catch (err) {
        console.error('[POST /api/chat] Error:', err);
        return res.status(500).json({ error: 'Something went wrong.' });
    }
});

export default router;