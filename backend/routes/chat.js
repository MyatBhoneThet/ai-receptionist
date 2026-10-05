import express from 'express';
import { chat } from '../services/llm.js';
import { validateBookingResponse } from '../validation/bookingSchema.js';
import { query } from '../services/db.js';
import { upsertEvent, isCalendarSyncEnabled } from '../services/googleCalendar.js';
import { chatLimiter } from '../middleware/rateLimiter.js';
import { createSessionToken, requireSessionToken } from '../middleware/auth.js';
import { notifyBooking } from '../services/notifications.js';
import { findUserByEmail, verifyAccessToken } from '../services/auth.js';
import { checkAvailability, findAlternativeAvailability, findDuplicateBooking } from '../services/availability.js';
import { formatDisplayDateValue } from '../services/dateOnly.js';
import {
    calendarToday, bookingDateKey, addBookingDays,
    bookingStayDays, extractNaturalBookingDate, hasBookingDateExpression,
} from '../services/bookingDates.js';

const router = express.Router();

// Apply chat-specific rate limit (20 req / 1 min per IP)
router.use(chatLimiter);

// simple in-memory session state
const sessionState = new Map();

function getTodayFormatted() {
    return calendarToday();
}

function normalizeDate(input) {
    if (!input) return input;

    return input.replace(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g, (_, d, m, y) => {
        return `${d.padStart(2, '0')}-${m.padStart(2, '0')}-${y}`;
    });
}

function parseDate(ddmmyyyy) {
    return bookingDateKey(ddmmyyyy);
}

function formatDate(date) {
    return formatDisplayDateValue(date);
}

function normalizeBooking(booking) {
    if (!booking) return booking;
    return {
        ...booking,
        phone_number: booking.contact_phone ?? booking.phone_number ?? '',
        date: formatDate(booking.date),
        end_date: formatDate(booking.end_date),
        // Ensure times are trimmed/formatted if needed, but usually they are OK strings
    };
}

function addDaysDisplay(displayDate, days) {
    return addBookingDays(displayDate, days);
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
        valid: bookingDateKey(data.date) && data.service_type && data.reservation_name,
        missing: [
            !bookingDateKey(data.date) && 'date',
            !data.service_type && 'type of reservation',
            !data.reservation_name && 'reservation name',
        ].filter(Boolean),
    };
}

function normalizeEditValue(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

const PEOPLE_WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
    fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const PEOPLE_PATTERN = `(?:\\d{1,3}|${Object.keys(PEOPLE_WORDS).join('|')})`;

function detectModifyField(message) {
    const text = normalizeEditValue(message).toLowerCase();
    if (!text) return null;
    if (/\b(check[ -]?out|departure)\b/.test(text)) return 'end_date';
    if (hasBookingDateExpression(text) || /\bday\b/.test(text)) return 'date';
    if (/\b(time|schedule|hour|hours)\b/.test(text)) return 'start_time';
    if (/\b(phone|telephone|mobile|contact number)\b/.test(text)) return 'contact_phone';
    if (/\b(name|guest name|reservation name)\b/.test(text)) return 'reservation_name';
    if (/\b(guest|guests|people|party size|party)\b/.test(text)) return 'people';
    if (/\b(room|venue|table|notes?|special requests?)\b/.test(text)) return 'notes';
    return null;
}

function extractModifyValue(field, message, today, allowBare = false) {
    const text = normalizeEditValue(message);
    if (!text) return null;
    if (field === 'date' || field === 'end_date') return extractNaturalBookingDate(text, today) || null;
    if (field === 'start_time') {
        // Keep HH:MM workflows and accept the common spoken form "9pm".
        const clock = text.match(/\b(\d{1,2})(?::(\d{2}))(?::\d{2})?\s*(am|pm)?\b/i)
            || text.match(/\b(\d{1,2})\s*(am|pm)\b/i);
        if (!clock) return null;
        let hours = Number(clock[1]);
        const shortClock = !clock[3] && /^(am|pm)$/i.test(clock[2] || '');
        const minutes = shortClock ? 0 : Number(clock[2] || 0);
        const suffix = (shortClock ? clock[2] : clock[3])?.toLowerCase();
        if (minutes > 59 || hours > (suffix ? 12 : 23) || hours < (suffix ? 1 : 0)) return null;
        if (suffix) hours = (hours % 12) + (suffix === 'pm' ? 12 : 0);
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
    }
    if (field === 'people') {
        const match = text.toLowerCase().match(new RegExp(`\\b(${PEOPLE_PATTERN})\\s+(?:guests?|people|persons?|adults?|pax)\\b`))
            || text.toLowerCase().match(new RegExp(`\\b(?:guests?|people|party(?: size)?)\\s*(?:count|number)?\\s*(?:is|to|for|of|:)?\\s*(${PEOPLE_PATTERN})\\b`));
        const bare = text.toLowerCase().replace(/^(?:actually |(?:make it|set it to|set to|change it to|change to|to|for)\s+)/, '');
        const value = match?.[1] || (allowBare && new RegExp(`^${PEOPLE_PATTERN}$`).test(bare) ? bare : null);
        const count = PEOPLE_WORDS[value] || Number(value);
        return value && Number.isInteger(count) && count > 0 ? count : null;
    }
    if (field === 'contact_phone') {
        const match = text.match(/\b(?:phone(?: number)?|telephone|mobile(?: number)?|contact(?: phone| number)?)\s*(?:is|into|to|as|will be|should be|would be|:|=)?\s*(?:the\s+)?(\+?\d[\d ()-]{5,}\d)/i);
        const value = match?.[1] || (allowBare && /^\+?[\d ()-]+$/.test(text) ? text : null);
        if (!value) return null;
        const digits = value.replace(/\D/g, '');
        return digits.length >= 7 && digits.length <= 15 ? `${value.startsWith('+') ? '+' : ''}${digits}` : null;
    }
    if (field === 'reservation_name' || field === 'notes') {
        const label = field === 'reservation_name' ? '(?:reservation |guest )?name' : '(?:notes?|special requests?)';
        const match = text.match(new RegExp(`\\b${label}\\s+(?:(?:is|to|as)\\s+)?(.+?)(?=\\s+(?:and|with|phone|contact|on)\\b|[.!?]|$)`, 'i'));
        const value = match?.[1] || (allowBare ? text.replace(/^(?:change|update|make it|set it to|set to|to|new)\s+/i, '') : null);
        return value && !/^(?:name|notes?|room|venue|table)$/i.test(value) ? value.trim() : null;
    }
    return null;
}

function extractModifyChanges(message, today, state) {
    const changes = { ...(state.modify_updates || {}) };
    const missing = [];
    const checkout = message.match(/\b(?:check[ -]?out|departure)(?: date)?\b/i);
    const awaitingCheckout = state.modify_step === 'awaiting_value' && state.modify_field === 'end_date' && !checkout;
    const arrivalText = awaitingCheckout ? '' : checkout ? message.slice(0, checkout.index) : message;
    const fields = ['date', 'end_date', 'start_time', 'people', 'contact_phone', 'reservation_name', 'notes'];
    const cues = {
        date: hasBookingDateExpression(arrivalText) || /\bday\b/i.test(arrivalText),
        end_date: Boolean(checkout),
        start_time: /\b(time|schedule|hours?)\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:am|pm)\b/i.test(message),
        people: /\b(?:guests?(?! name)|people|party(?: size)?|persons?|pax)\b/i.test(message),
        contact_phone: /\b(phone|telephone|mobile|contact number)\b/i.test(message),
        reservation_name: /\b(?:reservation |guest )?name\b/i.test(message),
        notes: /\b(notes?|special requests?)\b/i.test(message),
    };
    for (const field of fields) {
        const allowBare = state.modify_step === 'awaiting_value' && state.modify_field === field;
        if (!cues[field] && !allowBare) continue;
        const input = field === 'date' ? arrivalText : field === 'end_date' ? message.slice(checkout?.index || 0) : message;
        const value = extractModifyValue(field, input, today, allowBare);
        if (value === null || value === '') missing.push(field);
        else changes[field] = value;
    }
    return { changes, missing };
}

function buildModifyPrompt(field) {
    switch (field) {
        case 'date':
            return 'What date would you like instead? You can say tomorrow or seventh October this year, or use DD-MM-YYYY.';
        case 'end_date':
            return 'What check-out date would you like instead?';
        case 'contact_phone':
            return 'What phone number should I use instead?';
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
    const date = extractNaturalBookingDate(message, todayFormatted);
    if (date || hasBookingDateExpression(message)) return date;
    const dayMatch = normalizeEditValue(message).match(/\b(?:on\s+)?(\d{1,2})\b/i);
    return dayMatch ? extractNaturalBookingDate(`${dayMatch[1]}th`, todayFormatted) : '';
}

function extractBookingDate(message, todayFormatted) {
    return extractNaturalBookingDate(message, todayFormatted);
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
    // Names can contain date/type words (for example May or Friday). Only
    // interpret the surrounding text as the reservation date and service.
    const detailsText = reservationNameMatch
        ? `${text.slice(0, reservationNameMatch.index)} ${text.slice(reservationNameMatch.index + reservationNameMatch[0].length)}`
        : text;
    const service_type = inferServiceTypeFromMessage(detailsText);
    const date = extractLookupDate(detailsText, todayFormatted);

    return {
        service_type,
        date,
        reservation_name,
    };
}

function extractLookupCorrections(message, todayFormatted) {
    const text = normalizeEditValue(message);
    const criteria = extractLookupCriteria(text, todayFormatted);
    const updates = {};
    // A follow-up changes only fields present in this message. Do not let an
    // AI reconstruction of the conversation replace established search values.
    if (criteria.date) updates.date = criteria.date;
    else if (!criteria.reservation_name && hasBookingDateExpression(text)) updates.date = '';
    if (criteria.service_type) updates.service_type = criteria.service_type;
    if (criteria.reservation_name) updates.reservation_name = criteria.reservation_name;

    const bareName = text.replace(/^(?:actually[,:]?|it(?:'s| is)|my name is|the name is)\s+/i, '').replace(/[.!]$/, '').trim();
    const isName = /^[\p{L}][\p{L}\p{M}'’-]*(?:\s+[\p{L}][\p{L}\p{M}'’-]*){0,3}$/u.test(bareName);
    const isAcknowledgement = /^(?:yes|no|ok|okay|thanks|thank you|please|correct|right|try again|search again|never mind)$/i.test(bareName);
    const hasLookupInstruction = /\b(find|show|view|see|search|reservation|booking|date|name|type|please|cancel|change|update|modify|edit)\b/i.test(bareName);
    if (Object.keys(updates).length === 0 && isName && !isAcknowledgement && !hasLookupInstruction
        && !hasBookingDateExpression(bareName)) {
        updates.reservation_name = bareName;
    }
    return updates;
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
        [session_id, criteria.service_type || '', parseDate(criteria.date) || '', criteria.reservation_name || '']
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

        if (wantsExistingReservationChange(normalizedMessage) && (state.edit_booking_id || state.id)
            && !isReservationLookup(normalizedMessage)) {
            state = {
                ...state,
                modify_mode: 'modify_booking',
                modify_step: state.modify_step || 'choose_field',
                edit_booking_id: state.edit_booking_id || state.id,
            };
        }

        if (state.modify_step !== 'awaiting_lookup' && (isReservationLookup(normalizedMessage)
            || (wantsExistingReservationChange(normalizedMessage) && !state.edit_booking_id))) {
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

        if (wantsFreshReservation(normalizedMessage)
            && (state.modify_step !== 'awaiting_lookup' || /\b(book|reserve|new|another)\b/i.test(normalizedMessage))) {
            state = {
                reservation_name: '',
                phone_number: state.phone_number || '',
            };
            sessionState.set(session_id, state);
        }

        if (state.modify_step !== 'awaiting_lookup' && wantsReservationSlip(normalizedMessage)
            && !wantsExistingReservationChange(normalizedMessage)) {
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
                state = {
                    ...state,
                    ...extractLookupCorrections(normalizedMessage, today),
                    modify_mode: 'modify_booking',
                    modify_step: 'awaiting_lookup',
                };

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
                        confidence: 1,
                        session_token: sessionToken,
                    });
                }

                sessionState.set(session_id, state);

                const foundBooking = await findBookingForLookup(session_id, state);

                if (foundBooking) {
                    const booking = foundBooking;
                    state = {
                        ...state,
                        ...normalizeBooking(booking),
                        modify_mode: 'modify_booking',
                        modify_step: 'choose_field',
                        modify_field: null,
                        modify_missing: null,
                        edit_booking_id: booking.id,
                    };
                    sessionState.set(session_id, state);

                    const msg = `I've found your ${booking.service_type} reservation for ${state.date} under the name "${booking.reservation_name}". What would you like to change? You can say date, time, guests, phone number, notes, or name.`;
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
                    confidence: 1,
                    session_token: sessionToken,
                });
            }

            const { changes, missing } = extractModifyChanges(normalizedMessage, today, state);
            const requestedField = detectModifyField(normalizedMessage) || state.modify_field;
            if (missing.length > 0 || Object.keys(changes).length === 0) {
                const field = missing[0] || requestedField;
                state = {
                    ...state,
                    modify_mode: 'modify_booking',
                    modify_step: field ? 'awaiting_value' : 'choose_field',
                    modify_field: field,
                    modify_updates: changes,
                };
                sessionState.set(session_id, state);
                const msg = field ? buildModifyPrompt(field)
                    : 'What would you like to change? You can say date, time, guests, phone number, notes, or name.';
                await saveConversation(session_id, message, msg);
                return res.json({
                    intent: 'modify_booking', message: msg, speak: msg, data: state,
                    missing_fields: [], confidence: 1, session_token: sessionToken,
                });
            }

            const editBookingId = state.edit_booking_id || state.id;
            if (!editBookingId) {
                const msg = "I couldn't keep track of the booking we were editing. Please start the change again.";
                state = { ...state, modify_mode: null, modify_step: null, modify_field: null, edit_booking_id: null, modify_updates: null };
                sessionState.set(session_id, state);
                await saveConversation(session_id, message, msg);
                return res.json({
                    intent: 'modify_booking', message: msg, speak: msg, data: state,
                    missing_fields: [], confidence: 0.4, session_token: sessionToken,
                });
            }

            // Moving hotel arrival dates keeps the existing number of nights unless
            // the guest also supplies a new checkout date.
            if (state.service_type === 'hotel' && changes.date && !changes.end_date) {
                const stayDays = bookingStayDays(state.date, state.end_date);
                if (stayDays) changes.end_date = addBookingDays(changes.date, stayDays);
            }
            if (state.service_type === 'hotel' && (changes.date || changes.end_date)
                && !bookingStayDays(changes.date || state.date, changes.end_date || state.end_date)) {
                state = { ...state, modify_step: 'awaiting_value', modify_field: 'end_date', modify_updates: changes };
                sessionState.set(session_id, state);
                const msg = 'The check-out date must be after the check-in date. What check-out date would you like?';
                await saveConversation(session_id, message, msg);
                return res.json({
                    intent: 'modify_booking', message: msg, speak: msg, data: state,
                    missing_fields: [], confidence: 1, session_token: sessionToken,
                });
            }

            const columns = Object.keys(changes);
            const values = columns.map((column) => column === 'date' || column === 'end_date'
                ? parseDate(changes[column]) : changes[column]);
            const assignments = columns.map((column, index) => `${column} = $${index + 1}`).join(', ');
            const updated = await query(
                `UPDATE bookings SET ${assignments}, status = CASE WHEN status = 'confirmed' THEN 'modified' ELSE status END, updated_at = NOW()
                 WHERE id = $${values.length + 1} RETURNING *`,
                [...values, editBookingId]
            );
            if (updated.rows.length === 0) {
                const msg = "I couldn't update that booking just now. Please try again.";
                await saveConversation(session_id, message, msg);
                return res.json({
                    intent: 'modify_booking', message: msg, speak: msg, data: state,
                    missing_fields: [], confidence: 0.4, session_token: sessionToken,
                });
            }

            const rawBooking = updated.rows[0];
            let calendarSync = { status: isCalendarSyncEnabled() ? 'failed' : 'disabled' };
            if (calendarSync.status !== 'disabled') {
                try {
                    const eventId = await upsertEvent(rawBooking);
                    if (eventId) {
                        if (eventId !== rawBooking.google_event_id) {
                            await query('UPDATE bookings SET google_event_id = $1 WHERE id = $2', [eventId, rawBooking.id]);
                            rawBooking.google_event_id = eventId;
                        }
                        calendarSync = { status: 'synced' };
                    }
                } catch (calendarErr) {
                    console.error('[chat booking sync]', calendarErr.message);
                }
            }
            const booking = normalizeBooking(rawBooking);
            state = {
                ...state, ...booking, calendar_sync: calendarSync,
                modify_mode: 'modify_booking', modify_step: 'choose_field',
                modify_field: null, modify_updates: null, edit_booking_id: booking.id,
            };
            sessionState.set(session_id, state);
            const changedDetails = [];
            if (changes.date) changedDetails.push(`date ${booking.date}`);
            if (changes.end_date) changedDetails.push(`check-out ${booking.end_date}`);
            if (changes.people) changedDetails.push(`${booking.people} guests`);
            if (changes.contact_phone) changedDetails.push(`phone ${booking.phone_number}`);
            if (changes.start_time) changedDetails.push(`time ${booking.start_time}`);
            if (changes.reservation_name) changedDetails.push(`name ${booking.reservation_name}`);
            if (changes.notes) changedDetails.push('notes saved');
            const syncMessage = calendarSync.status === 'synced' ? ' Google Calendar has been updated.'
                : calendarSync.status === 'disabled' ? ' Google Calendar sync is disabled; your booking changes are saved.'
                    : ' Your booking changes are saved, but Google Calendar could not be updated.';
            const msg = `I've updated your ${booking.service_type} reservation: ${changedDetails.join(', ')}.${syncMessage}`;
            await saveConversation(session_id, message, msg);
            return res.json({
                intent: 'modify_booking', message: msg, speak: msg, data: state,
                missing_fields: [], confidence: 1, session_token: sessionToken,
            });
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

                const msg = `I've found your ${booking.service_type} reservation for ${data.date} under the name "${booking.reservation_name}". What would you like to change? You can say date, time, guests, phone number, notes, or name.`;
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
        let calendarSync = { status: isCalendarSyncEnabled() ? 'failed' : 'disabled' };
        try {
            if (confirmedBooking.status === 'confirmed') {
                if (calendarSync.status !== 'disabled') {
                    const eventId = await upsertEvent(confirmedBooking);
                    if (eventId) {
                        await query('UPDATE bookings SET google_event_id = $1 WHERE id = $2', [eventId, confirmedBooking.id]);
                        confirmedBooking.google_event_id = eventId;
                        calendarSync = { status: 'synced' };
                    }
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
                if (confirmedBooking.google_event_id && calendarSync.status !== 'disabled') {
                    const { cancelEvent } = await import('../services/googleCalendar.js');
                    if (await cancelEvent(confirmedBooking.google_event_id)) {
                        await query('UPDATE bookings SET google_event_id = NULL WHERE id = $1', [confirmedBooking.id]);
                        confirmedBooking.google_event_id = null;
                        calendarSync = { status: 'synced' };
                    }
                } else if (!confirmedBooking.google_event_id && calendarSync.status !== 'disabled') {
                    calendarSync = { status: 'synced' };
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

        state = { ...state, ...normalizeBooking(confirmedBooking), calendar_sync: calendarSync };
        sessionState.set(session_id, state);

        return res.json({
            success: true,
            booking_id: confirmedBooking.id,
            calendar_sync: calendarSync,
            message: calendarSync.status === 'synced' ? 'Booking saved and Google Calendar updated.'
                : calendarSync.status === 'disabled' ? 'Booking saved. Google Calendar sync is disabled.'
                    : 'Booking saved, but Google Calendar could not be updated.',
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
