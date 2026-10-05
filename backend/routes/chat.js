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
import { resolveBookingService, hasBookingServiceExpression } from '../services/bookingService.js';
import { validateBookingAlteration } from '../services/bookingAlteration.js';
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
    // A recovered reservation must not expose the original chat's access ID.
    const { session_id, ...details } = booking;
    return {
        ...details,
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
    const validType = ['hotel', 'restaurant', 'meeting'].includes(data.service_type);
    const validDate = !data.date_invalid && (!data.date || bookingDateKey(data.date));
    return {
        valid: validDate && validType && data.reservation_name,
        missing: [
            !validType && 'type of reservation',
            !data.reservation_name && 'reservation name',
            !validDate && 'date',
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
    if (/\b(?:end|finish|ending|finishing) time\b/.test(text)) return 'end_time';
    if (hasBookingDateExpression(text) || /\bday\b/.test(text)) return 'date';
    if (/\b(time|schedule|hour|hours)\b/.test(text)) return 'start_time';
    if (/\b(phone|telephone|mobile|contact number)\b/.test(text)) return 'contact_phone';
    if (/\b(name|guest name|reservation name)\b/.test(text)) return 'reservation_name';
    if (/\b(guest|guests|people|party size|party)\b/.test(text)) return 'people';
    if (/\b(room|venue|table|notes?|special requests?)\b/.test(text)) return 'notes';
    return null;
}

function extractTextEditSpan(field, message) {
    const label = field === 'reservation_name' ? '(?:reservation |guest )?name' : '(?:notes?|special requests?)';
    const nextField = '(?:date|check[ -]?in|check[ -]?out|start time|end time|time|guests?|people|phone|contact|reservation name|name|notes?)';
    return message.match(new RegExp(`\\b${label}\\s+(?:(?:is|to|as)\\s+)?(.+?)(?=\\s+(?:and|with)\\s+(?:(?:change|update|set)\\s+(?:the\\s+)?)?${nextField}\\b|[.!?]|$)`, 'i'));
}

function extractModifyValue(field, message, today, allowBare = false) {
    const text = normalizeEditValue(message);
    if (!text) return null;
    if (field === 'date' || field === 'end_date') return extractNaturalBookingDate(text, today) || null;
    if (field === 'start_time' || field === 'end_time') {
        const explicitClock = '(?:\\d{1,2}:\\d{2}(?::\\d{2})?\\s*(?:am|pm)?|\\d{1,2}\\s*(?:am|pm))';
        const range = text.match(new RegExp(`\\b(${explicitClock})\\s*(?:to|until|[-–])\\s*(${explicitClock})\\b`, 'i'));
        const endLabel = /\b(?:end|finish|ending|finishing) time\b/i;
        let clockText = range?.[field === 'start_time' ? 1 : 2];
        if (!clockText) {
            const ending = text.match(endLabel);
            const timingText = field === 'end_time' ? ending ? text.slice(ending.index + ending[0].length) : allowBare ? text : ''
                : ending ? text.slice(0, ending.index) : text;
            clockText = timingText.match(new RegExp(`\\b${explicitClock}\\b`, 'i'))?.[0];
            if (!clockText) {
                const labelled = timingText.match(/\b(?:start(?:ing)?(?: time)?|time)\s*(?:is|to|at|from|:)?\s*(\d{1,2})(?![\d:/-])/i);
                clockText = labelled?.[1] || (allowBare && /^\d{1,2}$/.test(timingText.trim()) ? timingText.trim() : null)
                    || (field === 'end_time' && /^\s*(?:is|to|at|:)?\s*\d{1,2}\s*$/i.test(timingText)
                        ? timingText.match(/\d{1,2}/)?.[0] : null);
            }
        }
        if (!clockText) return null;
        const clock = clockText.trim().match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$/i);
        if (!clock) return null;
        let hours = Number(clock[1]);
        const minutes = Number(clock[2] || 0);
        const suffix = clock[3]?.toLowerCase();
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
        const match = extractTextEditSpan(field, text);
        const value = match?.[1] || (allowBare ? text.replace(/^(?:change|update|make it|set it to|set to|to|new)\s+/i, '') : null);
        return value && !/^(?:name|notes?|room|venue|table)$/i.test(value) ? value.trim() : null;
    }
    return null;
}

function extractModifyChanges(message, today, state) {
    const changes = { ...(state.modify_updates || {}) };
    const missing = [];
    // Dates, times, guest counts, and phone numbers inside a name or note are
    // content, not instructions to amend another reservation field.
    let structuredText = message;
    for (const field of ['reservation_name', 'notes']) {
        const span = extractTextEditSpan(field, structuredText);
        if (span) structuredText = `${structuredText.slice(0, span.index)} ${structuredText.slice(span.index + span[0].length)}`;
    }
    if (state.modify_step === 'awaiting_value' && ['reservation_name', 'notes'].includes(state.modify_field)
        && !/\b(?:name|notes?|special requests?)\b/i.test(message)) structuredText = '';
    const checkout = structuredText.match(/\b(?:check[ -]?out|departure)(?: date)?\b/i);
    const awaitingCheckout = state.modify_step === 'awaiting_value' && state.modify_field === 'end_date' && !checkout;
    const awaitingEndTime = state.modify_step === 'awaiting_value' && state.modify_field === 'end_time'
        && !/\b(?:start|begin|from)\b/i.test(message);
    const arrivalText = awaitingCheckout ? '' : checkout ? structuredText.slice(0, checkout.index) : structuredText;
    const fields = ['date', 'end_date', 'start_time', 'end_time', 'people', 'contact_phone', 'reservation_name', 'notes'];
    const cues = {
        date: hasBookingDateExpression(arrivalText) || /\bday\b/i.test(arrivalText),
        end_date: Boolean(checkout),
        start_time: !awaitingEndTime && /\b(time|schedule|hours?)\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:am|pm)\b/i.test(structuredText.replace(/\b(?:end|finish|ending|finishing) time\b.*$/i, '')),
        end_time: /\b(?:end|finish|ending|finishing) time\b|\b(?:\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm))\s*(?:to|until|[-–])\s*\d/i.test(structuredText),
        people: /\b(?:guests?(?! name)|people|party(?: size)?|persons?|pax)\b/i.test(structuredText),
        contact_phone: /\b(phone|telephone|mobile|contact number)\b/i.test(structuredText),
        reservation_name: /\b(?:reservation |guest )?name\b/i.test(message),
        notes: /\b(notes?|special requests?)\b/i.test(message),
    };
    for (const field of fields) {
        const allowBare = state.modify_step === 'awaiting_value' && state.modify_field === field;
        if (!cues[field] && !allowBare) continue;
        const input = field === 'date' ? arrivalText : field === 'end_date' ? structuredText.slice(checkout?.index || 0)
            : ['reservation_name', 'notes'].includes(field) ? message : structuredText;
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
            return 'What time would you like instead? You can say 6pm or use HH:MM.';
        case 'end_time':
            return 'What end time would you like instead? You can say 7pm or use HH:MM.';
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

function buildModifyLookupPrompt(missingFields, candidates = []) {
    if (candidates.length > 1) return `Which reservation type do you mean: ${candidates.join(' or ')}?`;
    const typeHint = missingFields.includes('type of reservation') ? ' The type can be hotel, restaurant, or meeting.' : '';
    return `To find your booking, I'll need a few details: ${missingFields.join(', ')}.${typeHint}`;
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
    const hasModifyCue = /\b(change|modify|update|edit|alter|amend|reschedule|cancel|slip|show|view|my booking)\b/.test(text);
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
        /\b(change|modify|update|edit|alter|amend|reschedule)\b/.test(text) &&
        /\b(my|existing|already|reserved|booked)?\s*(booking|reservation|meeting|stay|dinner|room|table)\b/.test(text)
    );
}

function wantsReservationCancellation(message) {
    return /\bcancel\b.*\b(?:booking|reservation|meeting|stay|dinner|room|table)\b/i.test(message);
}

function wantsConversationClose(message, state) {
    const text = normalizeEditValue(message).toLowerCase().replace(/[.,!]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (/^(?:no (?:thank you|thanks)(?: very much)?|(?:that(?:'s| is)|this is) all(?: (?:thank you|thanks))?|nothing else(?: (?:thank you|thanks))?|goodbye|bye(?: bye)?|have a nice day)$/.test(text)) return true;
    return state.modify_step === 'anything_else' && /^(?:no|nope|thanks|thank you|all done|i(?:'m| am) done)$/.test(text);
}

function extractLookupPhone(message, today) {
    const labelled = extractModifyValue('contact_phone', message, today);
    if (labelled) return labelled;
    // Numeric dates are corrections, not a reservation's contact number.
    if (/^(?:\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}-\d{2}-\d{2})$/.test(message.trim())) return null;
    return extractModifyValue('contact_phone', message, today, true);
}

function redactLookupPhone(message) {
    return message.replace(/\b(?:phone(?: number)?|telephone|mobile(?: number)?|contact(?: phone| number)?)\s*(?:is|into|to|as|:|=)?\s*(\+?\d[\d ()-]{5,}\d)/ig, '');
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
    const detailsText = redactLookupPhone(reservationNameMatch
        ? `${text.slice(0, reservationNameMatch.index)} ${text.slice(reservationNameMatch.index + reservationNameMatch[0].length)}`
        : text);
    const service = resolveBookingService(detailsText);
    const date = extractLookupDate(detailsText, todayFormatted);

    return {
        service_type: service.service_type,
        service_candidates: service.ambiguous ? service.candidates : [],
        service_mentioned: hasBookingServiceExpression(detailsText),
        date,
        date_invalid: hasBookingDateExpression(detailsText) && !date,
        reservation_name,
    };
}

function extractLookupCorrections(message, todayFormatted) {
    const text = normalizeEditValue(message);
    const criteria = extractLookupCriteria(text, todayFormatted);
    const updates = {};
    // A follow-up changes only fields present in this message. Do not let an
    // AI reconstruction of the conversation replace established search values.
    if (criteria.date) { updates.date = criteria.date; updates.date_invalid = false; }
    else if (criteria.date_invalid) { updates.date = ''; updates.date_invalid = true; }
    if (criteria.service_type || criteria.service_mentioned) {
        updates.service_type = criteria.service_type;
        updates.service_candidates = criteria.service_candidates;
    }
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
         ORDER BY created_at DESC LIMIT 11`,
        [session_id, criteria.service_type || '', parseDate(criteria.date) || '', criteria.reservation_name || '']
    );

    return result.rows;
}

async function findRecoveredBooking(criteria, phone) {
    const result = await query(
        `SELECT * FROM bookings
         WHERE status IN ('pending', 'confirmed', 'modified')
           AND service_type = $1 AND ($2 = '' OR date = NULLIF($2, '')::date)
           AND LOWER(reservation_name) = LOWER($3)
           AND regexp_replace(COALESCE(contact_phone, ''), '[^0-9]', '', 'g') = $4
         ORDER BY created_at DESC LIMIT 11`,
        [criteria.service_type, parseDate(criteria.date) || '', criteria.reservation_name, phone.replace(/\D/g, '')]
    );
    return result.rows;
}

function reservationChoices(bookings) {
    return bookings.map((booking, index) => ({
        option_number: index + 1, id: booking.id, service_type: booking.service_type,
        date: formatDate(booking.date), start_time: String(booking.start_time || '').slice(0, 5),
        end_time: String(booking.end_time || '').slice(0, 5), people: booking.people,
    }));
}

function buildReservationChoicesMessage(options) {
    const choices = options.map((option) => `${option.option_number}. Reservation #${option.id}: ${option.date}${option.start_time ? ` at ${option.start_time}` : ''}${option.people != null ? `, ${option.people} guests` : ''}`);
    return `I found ${options.length} matching reservations. Which one would you like to alter?\n${choices.join('\n')}\nYou can reply with its number, date, or time.`;
}

async function respondToBookingLookup({ res, session_id, message, sessionToken, criteria, phone, action = 'modify', selectedBookingId }) {
    const lookup = getModifyLookupFields(criteria);
    const intent = action === 'cancel' ? 'cancel_booking' : 'modify_booking';
    let matches = [];
    if (lookup.valid) {
        if (selectedBookingId) {
            const selected = await query(
                `SELECT * FROM bookings WHERE id = $1 AND status IN ('pending', 'confirmed', 'modified')`,
                [selectedBookingId]
            );
            matches = selected.rows;
        } else {
            matches = await findBookingForLookup(session_id, criteria);
            if (!matches.length && phone) matches = await findRecoveredBooking(criteria, phone);
        }
    }

    let state;
    let reply;
    let missing;
    const booking = matches.length === 1 ? matches[0] : null;
    const searchState = {
        service_type: criteria.service_type || '', service_candidates: criteria.service_candidates || [],
        date: criteria.date || '', reservation_name: criteria.reservation_name || '',
        date_invalid: criteria.date_invalid || false,
        modify_mode: 'modify_booking', lookup_action: action,
    };
    if (booking) {
        state = {
            ...normalizeBooking(booking), modify_mode: 'modify_booking', modify_step: 'choose_field',
            edit_booking_id: booking.id, lookup_action: action, modify_missing: null,
        };
        missing = [];
        reply = `I've found your ${booking.service_type} reservation for ${state.date} under the name "${booking.reservation_name}". `
            + (action === 'cancel' ? 'Would you like to proceed with the cancellation?'
                : 'What would you like to alter? You can say date, time, guests, phone number, notes, or name.');
        if (action !== 'cancel' && wantsReservationSlip(message) && !wantsExistingReservationChange(message)) {
            reply = booking.people != null
                ? `Here is your reservation slip for ${booking.reservation_name}. You booked ${booking.people} guests for ${booking.service_type} on ${state.date}.`
                : `Here is your reservation slip for ${booking.reservation_name}. I have your ${booking.service_type} reservation on ${state.date}, but the guest count was not stored.`;
        }
    } else if (matches.length > 10) {
        missing = ['date'];
        state = { ...searchState, modify_step: 'awaiting_lookup', modify_missing: missing };
        reply = 'There are several matching reservations. Which date is the reservation you would like to alter?';
    } else if (matches.length > 1) {
        missing = ['reservation selection'];
        const options = reservationChoices(matches);
        state = { ...searchState, modify_step: 'awaiting_selection', modify_missing: missing,
            reservation_options: options, lookup_candidate_ids: matches.map((booking) => booking.id) };
        reply = buildReservationChoicesMessage(options);
        if (action === 'cancel') reply = reply.replace('alter', 'cancel');
    } else {
        missing = lookup.valid ? ['phone number'] : lookup.missing;
        state = { ...searchState,
            modify_step: lookup.valid ? 'awaiting_verification' : 'awaiting_lookup', modify_missing: missing };
        reply = !lookup.valid ? buildModifyLookupPrompt(missing, state.service_candidates)
            : phone ? "I couldn't match a reservation with those details and that phone number. Please check the original booking phone number, or correct the date, type, or name."
                : 'To find a reservation from another conversation, please give the phone number used for the original booking. You can also correct the date, type, or name.';
    }
    sessionState.set(session_id, state);
    await saveConversation(session_id, message, reply);
    const { lookup_candidate_ids, ...publicState } = state;
    return res.json({
        intent, message: reply, speak: reply, data: publicState, missing_fields: missing,
        confidence: booking ? 1 : 0.9,
        ...(booking ? action === 'cancel' ? { show_cancel_confirm: true } : { show_reservation_slip: true } : {}),
        session_token: sessionToken,
    });
}

function selectReservationOption(message, options, today) {
    const text = normalizeEditValue(message).toLowerCase();
    const reference = text.match(/^(?:the\s+)?(?:reservation|booking)\s*#\s*(\d+)[.!]?$/);
    if (reference) return options.filter((option) => String(option.id) === reference[1]);
    const ordinals = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
    const numbered = text.match(/^(?:the\s+)?(?:(?:option|number)\s*#?\s*)?(\d{1,2}|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?:\s+(?:one|booking|reservation))?[.!]?$/);
    if (numbered) {
        const index = ordinals[numbered[1]] || Number(numbered[1]);
        return options.filter((option) => option.option_number === index);
    }
    const date = extractNaturalBookingDate(text, today);
    const time = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:am|pm)\b/.test(text)
        ? extractModifyValue('start_time', text, today) : null;
    if (!date && !time) return [];
    return options.filter((option) => (!date || parseDate(option.date) === parseDate(date))
        && (!time || option.start_time === time.slice(0, 5)));
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
        if (wantsConversationClose(message, state)) {
            const farewell = 'Very well then, have a nice day.';
            sessionState.delete(session_id);
            await saveConversation(session_id, message, farewell);
            return res.json({ intent: 'farewell', message: farewell, speak: farewell,
                data: null, missing_fields: [], confidence: 1, session_token: sessionToken });
        }

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

        const lookupPending = ['awaiting_lookup', 'awaiting_verification', 'awaiting_selection'].includes(state.modify_step);
        const cancellation = wantsReservationCancellation(normalizedMessage);
        if (!lookupPending && (isReservationLookup(normalizedMessage) || cancellation
            || (wantsExistingReservationChange(normalizedMessage) && !state.edit_booking_id))) {
            const criteria = extractLookupCriteria(normalizedMessage, today);
            const hasCriteria = Boolean(criteria.date || criteria.service_type || criteria.reservation_name || criteria.service_candidates.length);
            const matchesSelection = (!criteria.date || parseDate(criteria.date) === parseDate(state.date))
                && (!criteria.service_type || criteria.service_type === state.service_type)
                && (!criteria.reservation_name || criteria.reservation_name.toLowerCase() === String(state.reservation_name).toLowerCase())
                && !criteria.service_candidates.length;
            if (cancellation && matchesSelection && (state.edit_booking_id || state.id)) {
                return respondToBookingLookup({ res, session_id, message, sessionToken, criteria: state,
                    action: 'cancel', selectedBookingId: state.edit_booking_id || state.id });
            }
            if (!(wantsReservationSlip(normalizedMessage) && !hasCriteria && !cancellation)) {
                return respondToBookingLookup({ res, session_id, message, sessionToken, criteria,
                    phone: extractLookupPhone(normalizedMessage, today), action: cancellation ? 'cancel' : 'modify' });
            }
        }

        if (wantsFreshReservation(normalizedMessage)
            && ((!lookupPending && state.booking_step !== 'awaiting_service')
                || /\b(book|reserve|new|another)\b/i.test(normalizedMessage))) {
            state = {
                reservation_name: '',
                phone_number: state.phone_number || '',
            };
            sessionState.set(session_id, state);
        }

        if (!lookupPending && wantsReservationSlip(normalizedMessage)
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
            if (state.modify_step === 'awaiting_selection') {
                const options = state.reservation_options || [];
                const selected = selectReservationOption(normalizedMessage, options, today);
                if (selected.length === 1 && state.lookup_candidate_ids?.includes(selected[0].id)) {
                    return respondToBookingLookup({ res, session_id, message, sessionToken,
                        criteria: { ...state, date: selected[0].date }, selectedBookingId: selected[0].id,
                        action: cancellation ? 'cancel' : state.lookup_action || 'modify' });
                }
                const corrections = extractLookupCriteria(normalizedMessage, today);
                // A new name/type requires a fresh authorized lookup. A date/time
                // selection stays within the choices that were already verified.
                if ((corrections.service_type && corrections.service_type !== state.service_type)
                    || (corrections.reservation_name && corrections.reservation_name.toLowerCase() !== state.reservation_name.toLowerCase())) {
                    return respondToBookingLookup({ res, session_id, message, sessionToken,
                        criteria: { ...state, ...corrections }, phone: extractLookupPhone(normalizedMessage, today),
                        action: cancellation ? 'cancel' : state.lookup_action || 'modify' });
                }
                const reply = `Please choose one reservation before I make any changes. ${buildReservationChoicesMessage(options)}`;
                await saveConversation(session_id, message, reply);
                const { lookup_candidate_ids, ...publicState } = state;
                return res.json({ intent: state.lookup_action === 'cancel' ? 'cancel_booking' : 'modify_booking',
                    message: reply, speak: reply, data: publicState, missing_fields: ['reservation selection'],
                    confidence: 1, session_token: sessionToken });
            }
            if (lookupPending) {
                const phone = extractLookupPhone(normalizedMessage, today);
                const barePhone = phone && /^\+?[\d ()-]+$/.test(normalizedMessage.trim());
                const corrections = barePhone ? {} : extractLookupCorrections(normalizedMessage, today);
                return respondToBookingLookup({ res, session_id, message, sessionToken,
                    criteria: { ...state, ...corrections }, phone,
                    action: cancellation ? 'cancel' : state.lookup_action || 'modify' });
            }

            if (state.modify_step === 'anything_else' && /^(?:yes|yes please|sure|of course)[.!]?$/i.test(normalizedMessage.trim())) {
                const reply = 'Of course. What else would you like me to help you with?';
                await saveConversation(session_id, message, reply);
                return res.json({ intent: 'modify_booking', message: reply, speak: reply, data: state,
                    missing_fields: [], confidence: 1, session_token: sessionToken });
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

            const latestSelected = await query(
                `SELECT * FROM bookings WHERE id = $1 AND status IN ('pending', 'confirmed', 'modified')`,
                [editBookingId]
            );
            if (!latestSelected.rows.length) {
                sessionState.delete(session_id);
                const reply = 'That reservation is no longer active. Please find the reservation you would like to alter again.';
                await saveConversation(session_id, message, reply);
                return res.json({ intent: 'modify_booking', message: reply, speak: reply, data: null,
                    missing_fields: [], confidence: 1, session_token: sessionToken });
            }
            state = { ...state, ...normalizeBooking(latestSelected.rows[0]) };

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

            const validation = await validateBookingAlteration(latestSelected.rows[0], changes);
            if (!validation.valid) {
                state = { ...state, modify_step: 'choose_field', modify_field: null, modify_updates: null };
                sessionState.set(session_id, state);
                await saveConversation(session_id, message, validation.message);
                return res.json({ intent: 'modify_booking', message: validation.message, speak: validation.message,
                    data: state, missing_fields: [], confidence: 1, session_token: sessionToken });
            }
            const finalChanges = validation.assignments;
            const columns = Object.keys(finalChanges);
            const values = columns.map((column) => column === 'date' || column === 'end_date'
                ? parseDate(finalChanges[column]) : finalChanges[column]);
            const assignments = columns.map((column, index) => `${column} = $${index + 1}`).join(', ');
            const updated = await query(
                `UPDATE bookings SET ${assignments}, status = CASE WHEN status = 'confirmed' THEN 'modified' ELSE status END, updated_at = NOW()
                 WHERE id = $${values.length + 1} AND status IN ('pending', 'confirmed', 'modified') RETURNING *`,
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
            let calendarSync = { status: rawBooking.waitlisted ? 'not_required' : isCalendarSyncEnabled() ? 'failed' : 'disabled' };
            if (calendarSync.status !== 'disabled' && !rawBooking.waitlisted) {
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
                modify_mode: 'modify_booking', modify_step: 'anything_else',
                modify_field: null, modify_updates: null, edit_booking_id: booking.id,
            };
            sessionState.set(session_id, state);
            const changedDetails = [];
            if (changes.date) changedDetails.push(`date ${booking.date}`);
            if (changes.end_date) changedDetails.push(`check-out ${booking.end_date}`);
            if (changes.people) changedDetails.push(`${booking.people} guests`);
            if (changes.contact_phone) changedDetails.push(`phone ${booking.phone_number}`);
            if (changes.start_time) changedDetails.push(`time ${booking.start_time}`);
            if (finalChanges.end_time) changedDetails.push(`end time ${booking.end_time}`);
            if (changes.reservation_name) changedDetails.push(`name ${booking.reservation_name}`);
            if (changes.notes) changedDetails.push('notes saved');
            const syncMessage = calendarSync.status === 'synced' ? ' Google Calendar has been updated.'
                : calendarSync.status === 'not_required' ? ' Your reservation remains on the waitlist.'
                : calendarSync.status === 'disabled' ? ' Google Calendar sync is disabled; your booking changes are saved.'
                    : ' Your booking changes are saved, but Google Calendar could not be updated.';
            const msg = `I've updated your ${booking.service_type} reservation: ${changedDetails.join(', ')}.${syncMessage} Is there anything else I can help you with?`;
            await saveConversation(session_id, message, msg);
            return res.json({
                intent: 'modify_booking', message: msg, speak: msg, data: state,
                missing_fields: [], confidence: 1, session_token: sessionToken,
            });
        }

        const llmResponse = await chat(history, normalizedMessage, today, state, memoryContext);

        const validation = validateBookingResponse(llmResponse);
        const parsed = validation.data;

        const requestedService = resolveBookingService(normalizedMessage);
        if (requestedService.service_type || requestedService.ambiguous) {
            parsed.data.service_type = requestedService.service_type;
            parsed.data.service_candidates = requestedService.ambiguous ? requestedService.candidates : [];
        }
        const creatingBooking = ['book_hotel', 'book_restaurant', 'book_meeting', 'new_booking'].includes(parsed.intent)
            || state.booking_step === 'awaiting_service'
            || (wantsFreshReservation(normalizedMessage) && /\b(book|reserve)\b/i.test(normalizedMessage));
        if (creatingBooking && requestedService.ambiguous) {
            const lookupDetails = extractLookupCriteria(normalizedMessage, today);
            state = {
                ...state, ...parsed.data,
                date: lookupDetails.date || state.date || parsed.data.date,
                reservation_name: lookupDetails.reservation_name || state.reservation_name || parsed.data.reservation_name,
                service_type: '', service_candidates: requestedService.candidates,
                booking_step: 'awaiting_service',
            };
            sessionState.set(session_id, state);
            const msg = buildModifyLookupPrompt(['type of reservation'], requestedService.candidates);
            await saveConversation(session_id, message, msg);
            return res.json({
                intent: 'new_booking', message: msg, speak: msg, data: state,
                missing_fields: ['type of reservation'], confidence: 1, session_token: sessionToken,
            });
        }
        if (creatingBooking) {
            const intentService = parsed.intent.replace(/^book_/, '');
            const service = requestedService.service_type
                || (['hotel', 'restaurant', 'meeting'].includes(state.service_type) ? state.service_type : '')
                || (['hotel', 'restaurant', 'meeting'].includes(intentService) ? intentService : '');
            if (service) {
                if (state.booking_step === 'awaiting_service') parsed.data = { ...parsed.data, ...state };
                parsed.data.service_type = service;
                parsed.intent = `book_${service}`;
                parsed.data.booking_step = null;
                parsed.data.service_candidates = [];
            }
        }

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
        } else if (intent === 'modify_booking' || intent === 'cancel_booking' || intent === 'cancel') {
            // Model-inferred requests follow the same access and verification rules
            // as deterministic lookup; model output is never proof of ownership.
            return respondToBookingLookup({ res, session_id, message, sessionToken, criteria: data,
                phone: extractLookupPhone(normalizedMessage, today),
                action: intent === 'modify_booking' ? 'modify' : 'cancel' });
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
            stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
            session_token: sessionToken,
        });
    }
});

// Clear chat context while preserving access to the session's reservations.
router.post('/reset', requireSessionToken, async (req, res) => {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id is required' });
    try {
        await query('DELETE FROM conversations WHERE session_id = $1', [session_id]);
        sessionState.delete(session_id);
        return res.json({ success: true });
    } catch (err) {
        console.error('[POST /api/chat/reset]', err.message);
        return res.status(500).json({ error: 'Could not clear the conversation. Please try again.' });
    }
});

// POST /api/chat/confirm(Finalize the most recent pending booking for this session)
router.post('/confirm', requireSessionToken, async (req, res) => {
    const { session_id, action, booking_id: expectedBookingId } = req.body;

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
        // Selection is assigned only after an authorized lookup, and is never
        // accepted from request JSON. Recovery keeps the booking's original session.
        const currentState = sessionState.get(session_id);
        if (['awaiting_lookup', 'awaiting_verification', 'awaiting_selection'].includes(currentState?.modify_step)) {
            return res.json({ success: false, message: 'Please find and verify the reservation first.', session_token: sessionToken });
        }
        const selectedId = currentState?.edit_booking_id;
        const latest = selectedId
            ? await query(
                `SELECT * FROM bookings WHERE id = $1 AND status IN ('pending', 'confirmed', 'modified')`,
                [selectedId]
            )
            : await query(
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
        // The displayed reservation must agree with the authorized server
        // selection, including after a restart or a change from another tab.
        if (expectedBookingId != null && String(expectedBookingId) !== String(bookingId)) {
            return res.json({ success: false, message: 'The reservation selection has expired. Please find the reservation again.', session_token: sessionToken });
        }

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

        state = confirmedBooking.status === 'cancelled' ? {}
            : { ...state, ...normalizeBooking(confirmedBooking), calendar_sync: calendarSync };
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
