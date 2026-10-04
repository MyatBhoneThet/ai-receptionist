import express from 'express';
import { chat } from '../services/llm.js';
import { validateBookingResponse } from '../validation/bookingSchema.js';
import { query } from '../services/db.js';
import { upsertEvent } from '../services/googleCalendar.js';
import { chatLimiter } from '../middleware/rateLimiter.js';
import { createSessionToken, requireSessionToken } from '../middleware/auth.js';
import { notifyBooking } from '../services/notifications.js';
import { findUserByEmail, verifyAccessToken } from '../services/auth.js';
import { checkAvailability, findAlternativeAvailability, findDuplicateBooking } from '../services/availability.js';
import { formatDisplayDateValue } from '../services/dateOnly.js';

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
    if (/^\d{4}-\d{2}-\d{2}$/.test(ddmmyyyy)) return ddmmyyyy;
    const [dd, mm, yyyy] = ddmmyyyy.split('-');
    if (!dd || !mm || !yyyy) return null;
    return `${yyyy}-${mm}-${dd}`;
}

function formatDate(date) {
    return formatDisplayDateValue(date);
}

function normalizeBooking(booking) {
    if (!booking) return booking;
    return {
        ...booking,
        date: formatDate(booking.date),
        end_date: formatDate(booking.end_date),
        // Ensure times are trimmed/formatted if needed, but usually they are OK strings
    };
}

function formatDisplayDate(date) {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
}

function parseToday(todayFormatted) {
    const [dd, mm, yyyy] = todayFormatted.split('-').map(Number);
    return new Date(yyyy, mm - 1, dd);
}

function toDisplayDate(value) {
    if (!value) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const [yyyy, mm, dd] = value.split('-');
        return `${dd}-${mm}-${yyyy}`;
    }
    const slashMatch = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (slashMatch) {
        const [, dd, mm, yyyy] = slashMatch;
        return `${dd.padStart(2, '0')}-${mm.padStart(2, '0')}-${yyyy}`;
    }
    return value;
}

function addDaysDisplay(displayDate, days) {
    const dbDate = parseDate(displayDate);
    if (!dbDate) return '';
    const [yyyy, mm, dd] = dbDate.split('-').map(Number);
    const date = new Date(yyyy, mm - 1, dd);
    date.setDate(date.getDate() + days);
    return formatDisplayDate(date);
}

function resolveOrdinalDate(day, monthHint, todayFormatted) {
    const today = parseToday(todayFormatted);
    const candidate = new Date(today.getFullYear(), today.getMonth(), day);

    if (monthHint === 'next') {
        candidate.setMonth(today.getMonth() + 1);
    } else if (!monthHint && day < today.getDate()) {
        candidate.setMonth(today.getMonth() + 1);
    }

    if (candidate.getDate() !== day) return '';
    return formatDisplayDate(candidate);
}

const WEEKDAY_INDEX = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
};

function resolveWeekdayDate(weekdayName, modifier, todayFormatted) {
    const today = parseToday(todayFormatted);
    const target = WEEKDAY_INDEX[weekdayName];
    if (target === undefined) return '';

    let daysAhead = (target - today.getDay() + 7) % 7;
    if (modifier === 'next' || daysAhead === 0) {
        daysAhead += 7;
    }

    const candidate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    candidate.setDate(candidate.getDate() + daysAhead);
    return formatDisplayDate(candidate);
}

function extractStayLengthDays(message) {
    const text = normalizeEditValue(message).toLowerCase();
    if (/\b(?:staying|stay|book(?:ing)?|reserve|reservation)?\s*(?:for\s+)?(?:a|one)\s+week\b/.test(text)) return 7;

    const durationMatch = text.match(/\b(?:staying|stay|book(?:ing)?|reserve|reservation)?\s*(?:for\s+)?(\d{1,2})\s+(night|nights|day|days|week|weeks)\b/);
    if (!durationMatch) return null;

    const amount = Number(durationMatch[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unit = durationMatch[2];
    return unit.startsWith('week') ? amount * 7 : amount;
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
                valid: data.date && data.start_time && (data.people || data.people === 0) && data.phone_number,
                missing: [
                    !data.date && 'date',
                    !data.start_time && 'start_time',
                    (!data.people && data.people !== 0) && 'people',
                    !data.reservation_name && 'reservation name',
                    !data.phone_number && 'phone number',
                ].filter(Boolean),
            };

        case 'book_hotel':
            return {
                valid: data.date && data.end_date && (data.people || data.people === 0) && data.phone_number,
                missing: [
                    !data.date && 'check-in date',
                    !data.end_date && 'check-out date',
                    (!data.people && data.people !== 0) && 'guests',
                    !data.reservation_name && 'reservation name',
                    !data.phone_number && 'phone number',
                ].filter(Boolean),
            };

        case 'book_meeting':
            return {
                valid:
                    data.date &&
                    data.start_time &&
                    data.end_time &&
                    (data.people || data.people === 0) &&
                    data.phone_number,
                missing: [
                    !data.date && 'date',
                    !data.start_time && 'start_time',
                    !data.end_time && 'end_time',
                    (!data.people && data.people !== 0) && 'people',
                    !data.reservation_name && 'reservation name',
                    !data.phone_number && 'phone number',
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

function buildBookingSummaryMessage(intent, data) {
    const nameText = data.reservation_name ? ` under the name ${data.reservation_name}` : '';
    const phoneText = data.phone_number ? `, with phone number ${data.phone_number}` : '';
    const optionText = data.inventory_option?.name
        ? ` I've selected ${data.inventory_option.name} for you.`
        : data.preferred_inventory
            ? ` I'll check for ${data.preferred_inventory} availability.`
            : '';

    if (intent === 'book_hotel') {
        return `I'd be delighted to help with your hotel room booking. You're checking in on ${data.date}, and your check-out date is ${data.end_date}. There will be ${data.people} guests in total${nameText}${phoneText}.${optionText} Shall I go ahead and confirm this for you?`;
    }

    if (intent === 'book_restaurant') {
        return `I'd be delighted to help with your restaurant booking. I have ${data.people} guests for ${data.date} at ${data.start_time}${nameText}${phoneText}.${optionText} Shall I go ahead and confirm this for you?`;
    }

    if (intent === 'book_meeting') {
        return `I'd be delighted to help with your meeting room booking. I have ${data.people} guests for ${data.date} from ${data.start_time} to ${data.end_time}${nameText}${phoneText}.${optionText} Shall I go ahead and confirm this for you?`;
    }

    return '';
}

function buildAlternativeMessage(data) {
    const alternative = data.alternative;
    if (!alternative) return '';

    const optionText = alternative.selected_option?.name
        ? ` at ${alternative.selected_option.name}`
        : '';
    const timeText = alternative.start_time
        ? ` from ${String(alternative.start_time).slice(0, 5)}${alternative.end_time ? ` to ${String(alternative.end_time).slice(0, 5)}` : ''}`
        : '';

    if (alternative.recommendation_type === 'place') {
        return ` I can recommend ${alternative.selected_option?.name || 'another available option'} at the same time instead.`;
    }

    if (alternative.recommendation_type === 'time') {
        return ` The nearest available time is ${alternative.date}${timeText}${optionText}.`;
    }

    return ` The next available option is ${alternative.date}${timeText}${optionText}.`;
}

function getModifyLookupFields(data) {
    return {
        valid: data.date && data.service_type && data.reservation_name,
        missing: [
            !data.date && 'date',
            !data.service_type && 'type of reservation',
            !data.reservation_name && 'reservation name',
        ].filter(Boolean),
    };
}

function normalizeEditValue(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function detectModifyField(message) {
    const text = normalizeEditValue(message).toLowerCase();

    if (!text) return null;
    if (/\b(date|day)\b/i.test(text)) return 'date';
    if (/\b(time|schedule|hour|hours)\b/i.test(text)) return 'start_time';
    if (/\b(name|guest name|reservation name)\b/i.test(text)) return 'reservation_name';
    if (/\b(guest|guests|people|party size|party)\b/i.test(text)) return 'people';
    if (/\b(room|venue|table)\b/i.test(text)) return 'notes';
    if (/\b(notes?|special requests?)\b/i.test(text)) return 'notes';

    return null;
}

function extractModifyValue(field, message) {
    const text = normalizeEditValue(message);
    const lower = text.toLowerCase();

    if (!text) return null;

    if (field === 'date') {
        const dateMatch = text.match(/\b(\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{4}-\d{2}-\d{2})\b/);
        if (!dateMatch) return null;
        return normalizeDate(dateMatch[1]);
    }

    if (field === 'start_time') {
        const timeMatch = text.match(/\b(\d{1,2}:\d{2})(?::\d{2})?\b/);
        if (!timeMatch) return null;
        const [hours, minutes] = timeMatch[1].split(':');
        return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:00`;
    }

    if (field === 'people') {
        const peopleMatch = text.match(/\b(\d{1,2})\b/);
        if (!peopleMatch) return null;
        return Number(peopleMatch[1]);
    }

    if (field === 'reservation_name' || field === 'notes') {
        const stripped = lower
            .replace(/^(change|update|make it|set it to|set to|to|new)\s+/i, '')
            .replace(/^(new\s+)?(name|notes?)\s+(is|to|as)\s+/i, '')
            .replace(/^(the )?(name|notes?)\s+(to|as)\s+/i, '')
            .trim();

        if (!stripped || stripped === field || stripped === 'name' || stripped === 'notes') {
            return null;
        }

        return text;
    }

    return null;
}

function buildModifyPrompt(field) {
    switch (field) {
        case 'date':
            return 'What date would you like instead? Please reply in DD-MM-YYYY.';
        case 'start_time':
            return 'What time would you like instead? Please reply in HH:MM.';
        case 'reservation_name':
            return 'What should the reservation name be instead?';
        case 'people':
            return 'How many guests should it be for instead?';
        case 'notes':
            return 'What notes would you like me to update?';
        default:
            return 'What would you like to change?';
    }
}

function buildModifyLookupPrompt(missingFields) {
    return `To find your booking, I'll need a few details: ${missingFields.join(', ')}`;
}

function wantsReservationSlip(message) {
    const text = normalizeEditValue(message).toLowerCase();
    return (
        /\b(reservation slip|booking slip)\b/.test(text) ||
        /\b(show|see|view)\b.*\b(reservation|booking|slip|details)\b/.test(text) ||
        /\b(show|see|view)\b.*\b(what|which)\s+.*\bbooked\b/.test(text) ||
        /\bmy booking\b/.test(text)
    );
}

function wantsFreshReservation(message) {
    const text = normalizeEditValue(message).toLowerCase();
    const hasBookingCue = /\b(book|reserve|reservation|booking|table|dinner|lunch|breakfast|room|meeting)\b/.test(text);
    const hasModifyCue = /\b(change|modify|update|edit|cancel|slip|show|view|my booking)\b/.test(text);
    return hasBookingCue && !hasModifyCue;
}

function isReservationLookup(message) {
    const text = normalizeEditValue(message).toLowerCase();
    return (
        /\b(show|see|view|find)\b/.test(text) &&
        (
            /\b(my|already|existing|reserved|booked)\b.*\b(booking|reservation)\b/.test(text) ||
            /\b(booking|reservation)\b.*\b(slip|details)\b/.test(text) ||
            /\breservation slip\b/.test(text)
        )
    );
}

function wantsExistingReservationChange(message) {
    const text = normalizeEditValue(message).toLowerCase();
    return (
        /\b(change|modify|update|edit)\b/.test(text) &&
        /\b(my|existing|already|reserved|booked)?\s*(booking|reservation)\b/.test(text)
    );
}

function inferServiceTypeFromMessage(text) {
    const value = normalizeEditValue(text).toLowerCase();
    if (/\b(dinner|lunch|breakfast|table|restaurant|dining)\b/.test(value)) return 'restaurant';
    if (/\b(hotel|room|suite|stay)\b/.test(value)) return 'hotel';
    if (/\b(meeting|boardroom|conference|meeting room)\b/.test(value)) return 'meeting';
    return '';
}

function extractLookupDate(message, todayFormatted) {
    const text = normalizeEditValue(message);
    const directMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (directMatch) return toDisplayDate(directMatch[1]);

    const fullDateMatch = text.match(/\b(\d{1,2}[/-]\d{1,2}[/-]\d{4})\b/);
    if (fullDateMatch) return toDisplayDate(fullDateMatch[1]);

    const dayMatch = text.match(/\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/i);
    if (!dayMatch) return '';

    const [todayDay, todayMonth, todayYear] = todayFormatted.split('-').map(Number);
    const day = Number(dayMatch[1]);
    if (!Number.isFinite(day) || day < 1 || day > 31) return '';

    const candidate = new Date(todayYear, todayMonth - 1, day);
    if (candidate.getMonth() !== todayMonth - 1) return '';

    if (day < todayDay) {
        candidate.setMonth(candidate.getMonth() + 1);
    }

    const dd = String(candidate.getDate()).padStart(2, '0');
    const mm = String(candidate.getMonth() + 1).padStart(2, '0');
    const yyyy = candidate.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
}

function extractBookingDate(message, todayFormatted) {
    const text = normalizeEditValue(message);
    const directMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (directMatch) return toDisplayDate(directMatch[1]);

    const slashMatch = text.match(/\b(\d{1,2}[/-]\d{1,2}[/-]\d{4})\b/);
    if (slashMatch) return toDisplayDate(slashMatch[1]);

    if (/\bday\s+after\s+tomorrow\b/i.test(text)) {
        return addDaysDisplay(todayFormatted, 2);
    }

    if (/\btomorrow\b/i.test(text)) {
        return addDaysDisplay(todayFormatted, 1);
    }

    if (/\btoday\b/i.test(text)) {
        return todayFormatted;
    }

    const weekdayMatch = text.match(/\b(?:(this|next)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
    if (weekdayMatch) {
        return resolveWeekdayDate(weekdayMatch[2].toLowerCase(), weekdayMatch[1]?.toLowerCase(), todayFormatted);
    }

    const nextMonthBeforeMatch = text.match(/\bnext\s+month\s+(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/i);
    if (nextMonthBeforeMatch) {
        return resolveOrdinalDate(Number(nextMonthBeforeMatch[1]), 'next', todayFormatted);
    }

    const ordinalMatch = text.match(/\b(?:on\s+)?(\d{1,2})(?:(?:st|nd|rd|th)(?:\s+(this|next)\s+month)?|\s+(this|next)\s+month)\b/i);
    if (!ordinalMatch) return '';

    const day = Number(ordinalMatch[1]);
    if (!Number.isFinite(day) || day < 1 || day > 31) return '';

    return resolveOrdinalDate(day, (ordinalMatch[2] || ordinalMatch[3])?.toLowerCase(), todayFormatted);
}

function extractExplicitBookingDates(message, todayFormatted) {
    const date = extractBookingDate(message, todayFormatted);
    const stayLengthDays = extractStayLengthDays(message);

    return {
        date,
        end_date: date && stayLengthDays ? addDaysDisplay(date, stayLengthDays) : '',
    };
}

function extractInventoryPreference(message) {
    const text = normalizeEditValue(message).toLowerCase();
    const patterns = [
        /\b(executive\s+suite|suite|deluxe|king|double|twin|premium|luxury|higher|highest)\s+(?:room|suite)?\b/i,
        /\b(?:room|suite)\s+(?:type\s+)?(?:is|as|to|for)?\s*(executive\s+suite|suite|deluxe|king|double|twin|premium|luxury|higher|highest)\b/i,
        /\b(window|patio|private|large)\s+table\b/i,
        /\b(boardroom|conference room|private meeting room|executive boardroom)\b/i,
    ];
    const match = patterns.map((pattern) => text.match(pattern)).find(Boolean);
    if (!match) return '';
    const value = (match[1] || match[0]).replace(/\s+/g, ' ').trim();
    if (['higher', 'highest', 'premium', 'luxury'].includes(value)) return 'suite';
    return value;
}

function extractLookupCriteria(message, todayFormatted) {
    const text = normalizeEditValue(message);
    const namePatterns = [
        /\bname\s+is\s+([a-z][a-z' -]{0,40}?)(?=\s+(?:and|type|with|for|on|in|under)\b|[.,!?]|$)/i,
        /\b(?:under\s+the\s+)?name\s+([a-z][a-z' -]{0,40}?)(?=\s+(?:and|type|with|for|on|in|under)\b|[.,!?]|$)/i,
        /\bfor\s+([a-z][a-z' -]{0,40}?)(?=\s+(?:and|type|with|on|in|under)\b|[.,!?]|$)/i,
    ];
    const reservationNameMatch = namePatterns.map((pattern) => text.match(pattern)).find(Boolean);
    const reservation_name = reservationNameMatch ? reservationNameMatch[1].trim().replace(/\s+/g, ' ') : '';
    const service_type = inferServiceTypeFromMessage(text);
    const date = extractLookupDate(text, todayFormatted);

    return {
        service_type,
        date,
        reservation_name,
    };
}

async function findBookingForLookup(session_id, criteria) {
    const result = await query(
        `SELECT * FROM bookings
         WHERE session_id = $1
           AND status IN ('pending', 'confirmed', 'modified')
           AND ($2 = '' OR service_type = $2)
           AND ($3 = '' OR date = NULLIF($3, '')::date)
           AND ($4 = '' OR LOWER(reservation_name) = LOWER($4))
         ORDER BY created_at DESC LIMIT 1`,
        [session_id, criteria.service_type || '', criteria.date || '', criteria.reservation_name || '']
    );

    return result.rows[0] || null;
}

async function loadLatestSessionBooking(session_id) {
    const result = await query(
        `SELECT * FROM bookings
         WHERE session_id = $1 AND status IN ('pending', 'confirmed', 'modified')
         ORDER BY created_at DESC LIMIT 1`,
        [session_id]
    );

    return result.rows[0] || null;
}

async function saveConversation(session_id, userMessage, assistantMessage) {
    await query(
        'INSERT INTO conversations (session_id, role, content) VALUES ($1, $2, $3)',
        [session_id, 'user', userMessage]
    );

    await query(
        'INSERT INTO conversations (session_id, role, content) VALUES ($1, $2, $3)',
        [session_id, 'assistant', assistantMessage]
    );
}

router.post('/', async (req, res) => {
    const { session_id, message, auth_token } = req.body;

    if (!session_id || !message) {
        return res.status(400).json({ error: 'session_id and message are required' });
    }

    let sessionToken;
    try {
        sessionToken = createSessionToken(session_id);
    } catch (err) {
        console.error('[POST /api/chat] Missing session signing secret:', err.message);
        return res.status(503).json({
            error: 'SESSION_SIGNING_SECRET is required for chat sessions.',
            detail: 'Set SESSION_SIGNING_SECRET in backend/.env and restart the backend.',
        });
    }

    try {
        const historyResult = await query(
            'SELECT role, content FROM conversations WHERE session_id = $1 ORDER BY created_at ASC',
            [session_id]
        );

        const history = historyResult.rows.slice(-10);
        const today = getTodayFormatted();

        // 🧠 LOAD STATE
        let state = sessionState.get(session_id) || {};

        // Memory Retrieval: If we have a phone number or auth, fetch profile/preferences to inject context
        let memoryContext = "";
        let identifiedCustomer = null;
        if (state.phone_number) {
            const customerResult = await query(
                'SELECT name, preferences FROM customers WHERE phone_number = $1',
                [state.phone_number]
            );
            if (customerResult.rows.length > 0) {
                const customer = customerResult.rows[0];
                identifiedCustomer = customer;
            }
        }

        if (!identifiedCustomer && auth_token) {
            try {
                const payload = verifyAccessToken(auth_token);
                if (payload?.email) {
                    const user = await findUserByEmail(payload.email);
                    if (user) {
                        identifiedCustomer = {
                            name: user.name,
                            preferences: user.preferences || {},
                        };
                    }
                }
            } catch (e) {
                // ignore token errors to avoid blocking chat
            }
        }

        if (identifiedCustomer) {
            memoryContext = `\n\n[SYSTEM INFO: RETURNING CUSTOMER IDENTIFIED]\nName: ${identifiedCustomer.name || 'Unknown'}.\nPreferences: ${JSON.stringify(identifiedCustomer.preferences)}.\nUse these preferences for recommendations and offers.`;
            state = {
                ...state,
                preferences: identifiedCustomer.preferences || {},
                reservation_name: state.reservation_name || identifiedCustomer.name || state.reservation_name,
            };
        }

        const normalizedMessage = normalizeDate(message);
        const inventoryPreference = extractInventoryPreference(normalizedMessage);
        if (inventoryPreference) {
            state = {
                ...state,
                preferred_inventory: inventoryPreference,
            };
            sessionState.set(session_id, state);
        }

        if (isReservationLookup(normalizedMessage) || wantsExistingReservationChange(normalizedMessage)) {
            const lookupCriteria = extractLookupCriteria(normalizedMessage, today);
            const hasLookupCriteria = Boolean(
                lookupCriteria.date || lookupCriteria.service_type || lookupCriteria.reservation_name
            );
            if (wantsReservationSlip(normalizedMessage) && !hasLookupCriteria) {
                // Let the slip shortcut below show the latest in-session booking.
            } else {
            const missingDetails = [];
            if (!lookupCriteria.date) missingDetails.push('date');
            if (!lookupCriteria.service_type) missingDetails.push('type of reservation');
            if (!lookupCriteria.reservation_name) missingDetails.push('reservation name');

            if (missingDetails.length > 0) {
                const msg = `To find your booking, I'll need a few details: ${missingDetails.join(', ')}`;
                state = {
                    ...state,
                    modify_mode: 'modify_booking',
                    modify_step: 'awaiting_lookup',
                    ...lookupCriteria,
                    modify_missing: missingDetails,
                };
                sessionState.set(session_id, state);
                await saveConversation(session_id, message, msg);
                return res.json({
                    intent: 'modify_booking',
                    message: msg,
                    speak: msg,
                    data: state,
                    missing_fields: missingDetails,
                    confidence: 0.9,
                    session_token: sessionToken,
                });
            }

            const foundBooking = await findBookingForLookup(session_id, lookupCriteria);

            if (foundBooking) {
                const booking = normalizeBooking(foundBooking);
                state = {
                    ...state,
                    ...booking,
                    modify_mode: 'modify_booking',
                    modify_step: 'choose_field',
                    edit_booking_id: booking.id,
                    modify_missing: null,
                };
                sessionState.set(session_id, state);

                const slipMessage = `Here is your reservation slip for ${booking.reservation_name}.`;
                await saveConversation(session_id, message, slipMessage);
                return res.json({
                    intent: 'modify_booking',
                    message: slipMessage,
                    speak: slipMessage,
                    data: state,
                    missing_fields: [],
                    confidence: 1,
                    show_reservation_slip: true,
                    session_token: sessionToken,
                });
            }

            const msg = `I couldn't find a ${lookupCriteria.service_type} reservation for ${lookupCriteria.date} under the name "${lookupCriteria.reservation_name}". Could you double-check the details?`;
            state = {
                ...state,
                modify_mode: 'modify_booking',
                modify_step: 'awaiting_lookup',
                ...lookupCriteria,
                modify_missing: missingDetails,
            };
            sessionState.set(session_id, state);
            await saveConversation(session_id, message, msg);
            return res.json({
                intent: 'modify_booking',
                message: msg,
                speak: msg,
                data: state,
                missing_fields: missingDetails,
                confidence: 0.9,
                session_token: sessionToken,
            });
            }
        }

        if (wantsFreshReservation(normalizedMessage)) {
            state = {
                reservation_name: '',
                phone_number: state.phone_number || '',
            };
            sessionState.set(session_id, state);
        }

        if (wantsReservationSlip(normalizedMessage)) {
            const latestBooking = state.edit_booking_id || state.id
                ? state
                : normalizeBooking(await loadLatestSessionBooking(session_id));

            if (latestBooking && latestBooking.id) {
                state = {
                    ...state,
                    ...normalizeBooking(latestBooking),
                    modify_mode: state.modify_mode || 'modify_booking',
                    modify_step: state.modify_step || 'choose_field',
                    edit_booking_id: latestBooking.id,
                };
                sessionState.set(session_id, state);

                const slipMessage = latestBooking.people != null
                    ? `Here is your reservation slip. You booked ${latestBooking.people} guests for ${latestBooking.service_type} on ${latestBooking.date}.`
                    : `Here is your reservation slip. I have your ${latestBooking.service_type} booking on ${latestBooking.date}, but the guest count was not stored.`;

                await saveConversation(session_id, message, slipMessage);
                return res.json({
                    intent: 'modify_booking',
                    message: slipMessage,
                    speak: slipMessage,
                    data: state,
                    missing_fields: [],
                    confidence: 1,
                    show_reservation_slip: true,
                    session_token: sessionToken,
                });
            }
        }

        if (state.modify_mode === 'modify_booking' && state.modify_step) {
            if (state.modify_step === 'awaiting_lookup') {
                const llmResponse = await chat(history, normalizedMessage, today, state, memoryContext);
                const validation = validateBookingResponse(llmResponse);
                const parsed = validation.data;

                const nextState = {
                    ...state,
                    ...parsed.data,
                    modify_mode: 'modify_booking',
                    modify_step: 'awaiting_lookup',
                };
                state = nextState;

                const lookup = getModifyLookupFields(state);
                if (!lookup.valid) {
                    state.modify_missing = lookup.missing;
                    sessionState.set(session_id, state);
                    const msg = buildModifyLookupPrompt(lookup.missing);
                    await saveConversation(session_id, message, msg);
                    return res.json({
                        intent: 'modify_booking',
                        message: msg,
                        speak: msg,
                        data: state,
                        missing_fields: lookup.missing,
                        confidence: parsed.confidence ?? 1,
                        session_token: sessionToken,
                    });
                }

                sessionState.set(session_id, state);

                const parsedDate = parseDate(state.date);
                const serviceType = String(state.service_type || '').toLowerCase().trim();
                const reservationName = String(state.reservation_name || '').toLowerCase().trim();

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
                    state = {
                        ...state,
                        ...normalizeBooking(booking),
                        modify_mode: 'modify_booking',
                        modify_step: 'choose_field',
                        modify_field: null,
                        edit_booking_id: booking.id,
                    };
                    sessionState.set(session_id, state);

                    const msg = `I've found your ${booking.service_type} reservation for ${state.date} under the name "${booking.reservation_name}". What would you like to change? You can say date, time, guests, notes, or name.`;
                    await saveConversation(session_id, message, msg);
                    return res.json({
                        intent: 'modify_booking',
                        message: msg,
                        speak: msg,
                        data: state,
                        missing_fields: [],
                        confidence: parsed.confidence ?? 1,
                        session_token: sessionToken,
                    });
                }

                const msg = `I couldn't find a ${state.service_type} reservation for ${state.date} under the name "${state.reservation_name}". Could you double-check the details?`;
                state = { ...state, modify_mode: 'modify_booking', modify_step: 'awaiting_lookup' };
                sessionState.set(session_id, state);
                await saveConversation(session_id, message, msg);
                return res.json({
                    intent: 'modify_booking',
                    message: msg,
                    speak: msg,
                    data: state,
                    missing_fields: [],
                    confidence: parsed.confidence ?? 1,
                    session_token: sessionToken,
                });
            }

            const requestedField = state.modify_step === 'choose_field'
                ? detectModifyField(normalizedMessage)
                : state.modify_field;

            if (state.modify_step === 'choose_field') {
                if (!requestedField) {
                    const msg = 'What would you like to change? You can say date, time, guests, notes, or name.';
                    await saveConversation(session_id, message, msg);
                    return res.json({
                        intent: 'modify_booking',
                        message: msg,
                        speak: msg,
                        data: state,
                        missing_fields: [],
                        confidence: 1,
                        session_token: sessionToken,
                    });
                }

                state = {
                    ...state,
                    modify_mode: 'modify_booking',
                    modify_step: 'awaiting_value',
                    modify_field: requestedField,
                };
                sessionState.set(session_id, state);

                const msg = buildModifyPrompt(requestedField);
                await saveConversation(session_id, message, msg);
                return res.json({
                    intent: 'modify_booking',
                    message: msg,
                    speak: msg,
                    data: state,
                    missing_fields: [],
                    confidence: 1,
                    session_token: sessionToken,
                });
            }

            if (state.modify_step === 'awaiting_value' && state.modify_field) {
                const alternateField = detectModifyField(normalizedMessage);
                if (alternateField && alternateField !== state.modify_field) {
                    state = {
                        ...state,
                        modify_mode: 'modify_booking',
                        modify_step: 'awaiting_value',
                        modify_field: alternateField,
                    };
                    sessionState.set(session_id, state);

                    const msg = buildModifyPrompt(alternateField);
                    await saveConversation(session_id, message, msg);
                    return res.json({
                        intent: 'modify_booking',
                        message: msg,
                        speak: msg,
                        data: state,
                        missing_fields: [],
                        confidence: 1,
                        session_token: sessionToken,
                    });
                }

                const updateValue = extractModifyValue(state.modify_field, normalizedMessage);
                if (updateValue === null || updateValue === undefined || updateValue === '') {
                    const msg = buildModifyPrompt(state.modify_field);
                    await saveConversation(session_id, message, msg);
                    return res.json({
                        intent: 'modify_booking',
                        message: msg,
                        speak: msg,
                        data: state,
                        missing_fields: [],
                        confidence: 1,
                        session_token: sessionToken,
                    });
                }

                const editBookingId = state.edit_booking_id || state.id;
                if (!editBookingId) {
                    const msg = "I couldn't keep track of the booking we were editing. Please start the change again.";
                    state = { ...state, modify_mode: null, modify_step: null, modify_field: null, edit_booking_id: null };
                    sessionState.set(session_id, state);
                    await saveConversation(session_id, message, msg);
                    return res.json({
                        intent: 'modify_booking',
                        message: msg,
                        speak: msg,
                        data: state,
                        missing_fields: [],
                        confidence: 0.4,
                        session_token: sessionToken,
                    });
                }

                const updateColumn = state.modify_field;
                const dbValue = updateColumn === 'date'
                    ? (parseDate(updateValue) || updateValue)
                    : updateColumn === 'people'
                        ? Number(updateValue)
                        : updateValue;
                const updated = await query(
                    `UPDATE bookings SET ${updateColumn} = $1, status = CASE WHEN status = 'confirmed' THEN 'modified' ELSE status END, updated_at = NOW()
                     WHERE id = $2 RETURNING *`,
                    [dbValue, editBookingId]
                );

                if (updated.rows.length === 0) {
                    const msg = "I couldn't update that booking just now. Please try again.";
                    await saveConversation(session_id, message, msg);
                    return res.json({
                        intent: 'modify_booking',
                        message: msg,
                        speak: msg,
                        data: state,
                        missing_fields: [],
                        confidence: 0.4,
                        session_token: sessionToken,
                    });
                }

                const booking = normalizeBooking(updated.rows[0]);
                try {
                    const eventId = await upsertEvent(booking);
                    if (eventId && eventId !== booking.google_event_id) {
                        await query('UPDATE bookings SET google_event_id = $1 WHERE id = $2', [eventId, booking.id]);
                        booking.google_event_id = eventId;
                    }
                } catch (calendarErr) {
                    console.error('[chat booking sync]', calendarErr);
                }
                state = {
                    ...state,
                    ...booking,
                    modify_mode: null,
                    modify_step: null,
                    modify_field: null,
                    edit_booking_id: null,
                };
                sessionState.set(session_id, state);

                const msg = `Perfect, I've updated your ${booking.service_type} reservation.`;
                await saveConversation(session_id, message, msg);

                return res.json({
                    intent: 'modify_booking',
                    message: msg,
                    speak: msg,
                    data: state,
                    missing_fields: [],
                    confidence: 1,
                    session_token: sessionToken,
                });
            }
        }

        const llmResponse = await chat(history, normalizedMessage, today, state, memoryContext);

        const validation = validateBookingResponse(llmResponse);
        const parsed = validation.data;

        if (inventoryPreference) {
            parsed.data.preferred_inventory = inventoryPreference;
            parsed.data.notes = [parsed.data.notes, `Requested option: ${inventoryPreference}`]
                .filter(Boolean)
                .join(' | ');
            if (
                !['book_restaurant', 'book_hotel', 'book_meeting'].includes(parsed.intent) &&
                ['restaurant', 'hotel', 'meeting'].includes(state.service_type)
            ) {
                parsed.intent = `book_${state.service_type}`;
            }
        }

        // Fallback manual phone extraction if LLM misses it
        if (!parsed.data.phone_number) {
            const phoneMatch = message.match(/(\+\d{1,3}[- ]?)?\d{10}/);
            if (phoneMatch) {
                parsed.data.phone_number = phoneMatch[0];
            }
        }

        const explicitBookingDates = extractExplicitBookingDates(normalizedMessage, today);
        if (explicitBookingDates.date) {
            parsed.data.date = explicitBookingDates.date;
        }
        if (parsed.intent === 'book_hotel' && explicitBookingDates.end_date) {
            parsed.data.end_date = explicitBookingDates.end_date;
        }

        // MERGE STATE (CRITICAL FIX)
        if (parsed.intent === 'new_booking') {
            state = {
                reservation_name: state.reservation_name || "",
                phone_number: state.phone_number || ""
            };
        } else {
            // Auto-detect service type change as a new booking to prevent overwrites
            const isBookingIntent = ['book_restaurant', 'book_hotel', 'book_meeting'].includes(parsed.intent);
            if (isBookingIntent) {
                const intentType = parsed.intent.replace('book_', '');
                if (state.service_type && state.service_type !== intentType) {
                    state = {
                        reservation_name: state.reservation_name || "",
                        phone_number: state.phone_number || ""
                    };
                }
            }

            // HOTEL FIX: Detect if the LLM mistakenly put only a checkout date in `date`.
            // Do not apply this when the user explicitly gave a new check-in date.
            if (
                state.service_type === 'hotel' &&
                !explicitBookingDates.date &&
                parsed.data.date &&
                state.date &&
                parsed.data.date !== state.date &&
                !parsed.data.end_date
            ) {
                // If we already have a check-in date, and LLM gives a NEW date, treat it as checkout
                parsed.data.end_date = parsed.data.date;
                parsed.data.date = state.date; 
            }

            state = {
                ...state,
                ...parsed.data,
            };
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
        let availability = null;

        if (bookableIntents.includes(intent)) {
            state.duplicate_blocked = false;
            state.duplicate_booking_id = null;

            const check = getRequiredFields(intent, data);

            if (!check.valid) {
                const missingText = `I need a bit more info: ${check.missing.join(', ')}`;
                return res.json({
                    ...parsed,
                    message: missingText,
                    speak: missingText,
                    missing_fields: check.missing,
                    session_token: sessionToken,
                });
            }

            const parsedDate = parseDate(data.date);
            let parsedEndDate = null;

            let startTime = parseTime(data.start_time);
            let endTime = parseTime(data.end_time);

            if (intent === 'book_hotel') {
                // For hotels, end_date is the checkout date
                parsedEndDate = parseDate(data.end_date);
                startTime = startTime || '14:00:00';
                endTime = endTime || '11:00:00';
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
                    `SELECT id, google_event_id, status, service_type, date, start_time, end_time, people, notes, reservation_name FROM bookings 
                     WHERE session_id = $1 AND status = 'pending'
                     ORDER BY created_at DESC LIMIT 1`,
                    [session_id]
                );
                if (existing.rows.length > 0) {
                    targetId = existing.rows[0].id;
                    // Keep existing values as defaults if not in current state
                    state = { ...normalizeBooking(existing.rows[0]), ...state };
                }
            }

            // Availability check — mark waitlist if no inventory
            try {
                availability = await checkAvailability({
                    service_type: data.service_type || intent.replace('book_', ''),
                    date: data.date,
                    end_date: data.end_date,
                    start_time: startTime,
                    end_time: endTime,
                    people: data.people,
                    preferred_inventory: data.preferred_inventory || state.preferred_inventory,
                    exclude_booking_id: targetId || state.id,
                });
                state.waitlisted = availability.waitlist;
                const serviceType = data.service_type || intent.replace('book_', '');
                state.hotel_room_id = null;
                state.table_id = null;
                state.meeting_room_id = null;
                if (serviceType === 'hotel') {
                    state.hotel_room_id = availability.selected_option?.id || null;
                } else if (serviceType === 'restaurant') {
                    state.table_id = availability.selected_option?.id || null;
                } else if (serviceType === 'meeting') {
                    state.meeting_room_id = availability.selected_option?.id || null;
                }
                state.inventory_id = availability.selected_option?.id || null;
                state.inventory_option = availability.selected_option || null;
                if (availability.waitlist) {
                    const alt = await findAlternativeAvailability({
                        service_type: data.service_type || intent.replace('book_', ''),
                        date: data.date,
                        end_date: data.end_date,
                        start_time: startTime,
                        end_time: endTime,
                        people: data.people,
                        preferred_inventory: data.preferred_inventory || state.preferred_inventory,
                    });
                    if (alt) {
                        state.alternative = alt;
                    }
                } else {
                    state.alternative = null;
                }
            } catch (availErr) {
                console.error('[chat availability]', availErr);
            }

            const duplicate = await findDuplicateBooking({
                service_type: data.service_type || (intent.startsWith('book_') ? intent.replace('book_', '') : ''),
                date: parsedDate,
                end_date: parsedEndDate,
                start_time: startTime,
                end_time: endTime,
                reservation_name: data.reservation_name,
                contact_phone: data.phone_number || state.phone_number || null,
                hotel_room_id: state.hotel_room_id || null,
                table_id: state.table_id || null,
                meeting_room_id: state.meeting_room_id || null,
                exclude_booking_id: targetId,
            });

            if (duplicate) {
                state = {
                    ...state,
                    ...normalizeBooking(duplicate),
                    duplicate_booking_id: duplicate.id,
                    duplicate_blocked: true,
                };
                sessionState.set(session_id, state);
                const duplicateMessage = `I found an existing ${duplicate.service_type} booking for ${data.reservation_name} at that same date and time, so I won't create a duplicate.`;
                parsed.message = duplicateMessage;
                parsed.speak = duplicateMessage;
            } else if (targetId) {
                const updated = await query(
                    `UPDATE bookings SET
                        service_type = $1,
                        date = $2,
                        end_date = $3,
                        start_time = $4,
                        end_time = $5,
                        people = $6,
                        notes = $7,
                        reservation_name = $8,
                        waitlisted = $9,
                        hotel_room_id = $10,
                        table_id = $11,
                        meeting_room_id = $12,
                        status = CASE WHEN status = 'confirmed' THEN 'modified' ELSE status END,
                        updated_at = NOW()
                      WHERE id = $13 RETURNING *`,
                    [
                        data.service_type || (intent.startsWith('book_') ? intent.replace('book_', '') : ''),
                        parsedDate,
                        parsedEndDate,
                        startTime,
                        endTime,
                        data.people,
                        data.notes,
                        data.reservation_name,
                        state.waitlisted || false,
                        state.hotel_room_id || null,
                        state.table_id || null,
                        state.meeting_room_id || null,
                        targetId,
                    ]
                );
                state = { ...state, ...normalizeBooking(updated.rows[0]) };

                // Premature Sync Removed: confirmation now happens in /confirm
            } else {
                // First ensure customer exists/is updated
                let customerId = null;
                if (data.phone_number) {
                    const custResult = await query(
                        `INSERT INTO customers (phone_number, name)
                         VALUES ($1, $2)
                         ON CONFLICT (phone_number) 
                         DO UPDATE SET name = COALESCE(customers.name, EXCLUDED.name), updated_at = NOW()
                         RETURNING id`,
                        [data.phone_number, data.reservation_name]
                    );
                    customerId = custResult.rows[0].id;
                }

                const result = await query(
                    `INSERT INTO bookings 
                    (session_id, service_type, date, end_date, start_time, end_time, people, notes, reservation_name, status, customer_id, contact_phone, contact_email, waitlisted, hotel_room_id, table_id, meeting_room_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
                    [
                        session_id,
                        data.service_type || (intent.startsWith('book_') ? intent.replace('book_', '') : ''),
                        parsedDate,
                        parsedEndDate,
                        startTime,
                        endTime,
                        data.people,
                        data.notes,
                        data.reservation_name,
                        customerId,
                        data.phone_number || state.phone_number || null,
                        data.email || null,
                        state.waitlisted || false,
                        state.hotel_room_id || null,
                        state.table_id || null,
                        state.meeting_room_id || null,
                    ]
                );

                // 🔄 Premature Sync Removed: confirmation now happens in /confirm
                const newBooking = result.rows[0];
                state = { ...state, ...normalizeBooking(newBooking) };
                sessionState.set(session_id, state);
            }

            const summaryMessage = state.duplicate_blocked ? '' : buildBookingSummaryMessage(intent, state);
            if (summaryMessage) {
                parsed.message = summaryMessage;
                parsed.speak = summaryMessage;
            }
        } else if (intent === 'modify_booking') {
            const check = getModifyLookupFields(data);

            if (!check.valid) {
                state = {
                    ...state,
                    ...data,
                    modify_mode: 'modify_booking',
                    modify_step: 'awaiting_lookup',
                    modify_missing: check.missing,
                };
                sessionState.set(session_id, state);

                const missingText = buildModifyLookupPrompt(check.missing);
                await saveConversation(session_id, message, missingText);
                return res.json({
                    ...parsed,
                    data: state,
                    message: missingText,
                    speak: missingText,
                    missing_fields: check.missing,
                    confidence: parsed.confidence ?? 1,
                    session_token: sessionToken,
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
                // Update state with booking info BUT allow new data from current turn to override
                state = {
                    ...state,
                    ...normalizeBooking(booking),
                    ...parsed.data,
                    modify_mode: 'modify_booking',
                    modify_step: 'choose_field',
                    modify_field: null,
                    modify_missing: null,
                    edit_booking_id: booking.id,
                };
                sessionState.set(session_id, state);

                const msg = `I've found your ${booking.service_type} reservation for ${data.date} under the name "${booking.reservation_name}". What would you like to change? You can say date, time, guests, notes, or name.`;
                return res.json({
                    ...parsed,
                    message: msg,
                    speak: msg,
                    data: state,
                    session_token: sessionToken,
                });
            } else {
                const msg = `I couldn't find a ${data.service_type} reservation for ${data.date} under the name "${data.reservation_name}". Could you double-check the details?`;
                return res.json({
                    ...parsed,
                    message: msg,
                    speak: msg,
                    data: state,
                    session_token: sessionToken,
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
                    session_token: sessionToken,
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
                state = { ...state, ...normalizeBooking(booking) };
                sessionState.set(session_id, state);

                const msg = `I've found your ${booking.service_type} reservation for ${data.date} under the name "${booking.reservation_name}". Would you like to proceed with the cancellation?`;
                return res.json({
                    ...parsed,
                    message: msg,
                    speak: msg,
                    data: state,
                    show_cancel_confirm: true, // New flag for frontend
                    session_token: sessionToken,
                });
            } else {
                const msg = `I'm so sorry, but I couldn't find a ${data.service_type} reservation for ${data.date} under the name "${data.reservation_name}". Could you double-check the details for me?`;
                return res.json({
                    ...parsed,
                    message: msg,
                    speak: msg,
                    data: state,
                    session_token: sessionToken,
                });
            }
        }

        // Add friendly message for waitlist with alternatives
        let responseMessage = parsed.message;
        if (state.waitlisted && state.alternative) {
            responseMessage += `\n\nWe're currently full for that exact request.${buildAlternativeMessage(state)} Do you want to switch to that option or join the waitlist?`;
        } else if (state.waitlisted) {
            responseMessage += `\n\nWe're currently full for that exact request. I can add you to the waitlist, or we can try a different date, time, or party size.`;
        } else if (state.inventory_option?.name && bookableIntents.includes(intent)) {
            responseMessage += `\n\nAvailability checked: ${state.inventory_option.name} is open for this request.`;
        }

        return res.json({
            ...parsed,
            message: responseMessage,
            data: state, // always return merged state
            availability: state.waitlisted !== undefined ? {
                available: availability?.available,
                total: availability?.total,
                waitlist: state.waitlisted,
                reason: availability?.reason,
                selected_option: state.inventory_option,
                occupied_option: availability?.occupied_option,
                place_recommendation: availability?.place_recommendation,
                options: availability?.options,
                other_options: availability?.other_options,
                alternative: state.alternative,
            } : undefined,
            session_token: sessionToken,
        });

    } catch (err) {
        console.error('[POST /api/chat] CRASH:', err);
        return res.status(500).json({ 
            error: 'Something went wrong.', 
            details: err.message,
            stack: process.env.NODE_ENV === 'development' ? err.stack : undefined 
        });
    }
});

// POST /api/chat/confirm(Finalize the most recent pending booking for this session)
router.post('/confirm', requireSessionToken, async (req, res) => {
    const { session_id, action } = req.body;

    if (!session_id) {
        return res.status(400).json({ error: 'session_id is required' });
    }

    let sessionToken;
    try {
        sessionToken = createSessionToken(session_id);
    } catch (err) {
        console.error('[POST /api/chat/confirm] Missing session signing secret:', err.message);
        return res.status(503).json({
            error: 'SESSION_SIGNING_SECRET is required for booking confirmations.',
            detail: 'Set SESSION_SIGNING_SECRET in backend/.env and restart the backend.',
        });
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
            return res.json({ success: false, message: 'No active booking found.', session_token: sessionToken });
        }

        const bookingId = latest.rows[0].id;
        const currentStatus = latest.rows[0].status;

        // Determine target status
        let targetStatus = 'confirmed';
        if (action === 'cancel') {
            targetStatus = 'cancelled';
        } else if (currentStatus === 'confirmed') {
            // Already confirmed, no need to update status unless it was 'modified'
            return res.json({ success: true, booking_id: bookingId, message: 'Already confirmed.', session_token: sessionToken });
        }

        const result = await query(
            `UPDATE bookings SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
            [targetStatus, bookingId]
        );

        if (result.rows.length === 0) {
            return res.json({ success: false, message: 'No booking found to update.', session_token: sessionToken });
        }

        const confirmedBooking = result.rows[0];

        // 🧠 SYNC SESSION STATE (IMPORTANT)
        let state = sessionState.get(session_id) || {};
        state = { ...state, ...normalizeBooking(confirmedBooking) };
        sessionState.set(session_id, state);

        // Final Sync with Google Calendar on explicit confirmation
        try {
            if (confirmedBooking.status === 'confirmed') {
                const eventId = await upsertEvent(confirmedBooking);
                if (eventId) {
                    await query('UPDATE bookings SET google_event_id = $1 WHERE id = $2', [eventId, confirmedBooking.id]);
                }
                // Notify customer
                await notifyBooking({
                    type: 'confirm',
                    toEmail: confirmedBooking.contact_email,
                    toPhone: confirmedBooking.contact_phone,
                    booking: confirmedBooking,
                    isVip: false,
                });
            } else if (confirmedBooking.status === 'cancelled') {
                if (confirmedBooking.google_event_id) {
                    const { cancelEvent } = await import('../services/googleCalendar.js');
                    await cancelEvent(confirmedBooking.google_event_id);
                    await query('UPDATE bookings SET google_event_id = NULL WHERE id = $1', [confirmedBooking.id]);
                }
                await notifyBooking({
                    type: 'cancel',
                    toEmail: confirmedBooking.contact_email,
                    toPhone: confirmedBooking.contact_phone,
                    booking: confirmedBooking,
                    isVip: false,
                });
                // try to promote waitlist for this date/service
                try {
                    const { promoteWaitlist } = await import('./bookings.js');
                    await promoteWaitlist({ service_type: confirmedBooking.service_type, date: confirmedBooking.date });
                } catch (e) {
                    // ignore
                }
            }
        } catch (syncErr) {
            console.error('[POST /api/chat/confirm] Calendar Sync Error:', syncErr);
            // We still consider the booking confirmed in our DB even if calendar fails
        }

        return res.json({
            success: true,
            booking_id: confirmedBooking.id,
            session_token: sessionToken,
        });
    } catch (err) {
        console.error('[POST /api/chat/confirm] Error:', err);
        return res.status(500).json({ error: 'Something went wrong.' });
    }
});

export default router;
async function findNextAvailableSlot({ service_type, date, start_time, daysToScan = 7 }) {
    const base = parseDate(date);
    if (!base) return null;
    for (let i = 1; i <= daysToScan; i++) {
        const d = new Date(`${base}T00:00:00`);
        d.setDate(d.getDate() + i);
        const candidate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        try {
            const res = await checkAvailability({ service_type, date: candidate, start_time, end_time: null });
            if (!res.waitlist && res.available > 0) {
                return { date: candidate, available: res.available, total: res.total };
            }
        } catch (e) {
            // continue
        }
    }
    return null;
}
