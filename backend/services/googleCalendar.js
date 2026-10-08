import { google } from 'googleapis';
import 'dotenv/config';
import { formatDateKey } from './dateOnly.js';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const defaultCalendarId = process.env.GOOGLE_CALENDAR_ID;
const CALENDAR_TIMEZONE = process.env.CALENDAR_TIMEZONE || 'Asia/Bangkok';

// Fix private key formatting safely
const processedKey = process.env.GOOGLE_PRIVATE_KEY
    ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\+n/g, '\n')
    : null;

export function isCalendarSyncEnabled(calendarId = defaultCalendarId) {
    return Boolean(calendarId && process.env.GOOGLE_CLIENT_EMAIL && processedKey);
}

// Validate env early
if (!isCalendarSyncEnabled()) {
    console.warn('[Google Calendar] Missing credentials. Calendar sync disabled.');
}

const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: processedKey,
    scopes: SCOPES,
});

const calendar = google.calendar({ version: 'v3', auth });

// Format date as YYYY-MM-DD (safe)
function formatDateLocal(date) {
    if (!date) return null;

    if (typeof date === 'string') {
        // Parse date-only strings explicitly; JS Date treats ambiguous
        // DD-MM-YYYY values as US month-first dates.
        const dmY = date.match(/^(\d{2})-(\d{2})-(\d{4})$/);
        const dateKey = dmY ? `${dmY[3]}-${dmY[2]}-${dmY[1]}` : date;
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
            const parsed = new Date(`${dateKey}T00:00:00Z`);
            return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === dateKey
                ? dateKey
                : null;
        }
        // Only offset-bearing timestamps have an unambiguous instant to convert.
        if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(date)) return null;
        const parsed = new Date(date);
        if (Number.isNaN(parsed.getTime())) return null;
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
            timeZone: CALENDAR_TIMEZONE,
            year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(parsed).map(({ type, value }) => [type, value]));
        return `${parts.year}-${parts.month}-${parts.day}`;
    }

    // pg represents SQL DATE values as local-midnight Date objects.
    // Preserve that calendar day instead of shifting it to another zone.
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    return formatDateKey(date);
}

// Build ISO datetime safely WITHOUT shifting timezone incorrectly
function buildDateTime(dateStr, timeStr) {
    const match = String(timeStr || '12:00:00').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] || 0) > 59) return null;
    const time = `${match[1].padStart(2, '0')}:${match[2]}:${match[3] || '00'}`;
    return `${dateStr}T${time}`;
}

// Create or update event
export async function upsertEvent(booking, target = {}) {
    // `target.calendarId` selects a business's own calendar; the default is the
    // deployment-wide calendar from the environment.
    const calendarId = target.calendarId || defaultCalendarId;
    if (!isCalendarSyncEnabled(calendarId)) return null;

    try {
        const {
            id,
            service_type,
            date,
            end_date,
            start_time,
            end_time,
            people,
            notes,
            google_event_id,
        } = booking;

        const startDateStr = formatDateLocal(date);
        const parsedEndDate = formatDateLocal(end_date);
        const endDateStr = parsedEndDate || startDateStr;

        if (!startDateStr) {
            console.error('[Google Calendar] Invalid start date');
            return null;
        }
        if (end_date && !parsedEndDate) {
            console.error('[Google Calendar] Invalid end date');
            return null;
        }

        const summary = `AI Receptionist: ${capitalize(service_type)} (#${id})`;

        const description = [
            `Service: ${service_type}`,
            `People: ${people ?? 'N/A'}`,
            `Notes: ${notes || 'None'}`,
            `Internal ID: ${id}`,
        ].join('\n');

        // Ensure end is AFTER start
        let finalStartTime = buildDateTime(startDateStr, start_time);
        let finalEndTime = buildDateTime(endDateStr, end_time || start_time);

        if (!finalStartTime || !finalEndTime) {
            console.error('[Google Calendar] Invalid booking time');
            return null;
        }

        // Simple check: if end <= start on the same day OR if start > end across days
        if (finalEndTime <= finalStartTime) {
            console.log('[Google Calendar] Adjusting invalid time range...');
            // Advance wall-clock fields independently of the host timezone.
            const startDT = new Date(`${finalStartTime}Z`);
            const adjustedEndDT = new Date(startDT.getTime() + 60 * 60 * 1000); // Default to +1 hour
            finalEndTime = adjustedEndDT.toISOString().slice(0, 19);
        }

        const event = {
            summary,
            description,
            start: {
                dateTime: finalStartTime,
                timeZone: CALENDAR_TIMEZONE,
            },
            end: {
                dateTime: finalEndTime,
                timeZone: CALENDAR_TIMEZONE,
            },
        };

        if (google_event_id) {
            const res = await calendar.events.update({
                calendarId,
                eventId: google_event_id,
                resource: event,
            });

            console.log('[Google Calendar] Updated:', res.data.htmlLink);
            return google_event_id;
        }

        const res = await calendar.events.insert({
            calendarId,
            resource: event,
        });

        console.log('[Google Calendar] Created:', res.data.htmlLink);
        return res.data.id;

    } catch (error) {
        console.error('[Google Calendar] Sync error:', error.message);

        // Recover if event was deleted manually
        if ([404, 410].includes(Number(error.code || error.response?.status)) && booking.google_event_id) {
            console.log('[Google Calendar] Recreating deleted event...');
            return upsertEvent({ ...booking, google_event_id: null }, target);
        }

        return null;
    }
}

// Delete event
export async function cancelEvent(googleEventId, target = {}) {
    const calendarId = target.calendarId || defaultCalendarId;
    if (!calendarId || !googleEventId) return false;

    try {
        await calendar.events.delete({
            calendarId,
            eventId: googleEventId,
        });

        console.log('[Google Calendar] Deleted:', googleEventId);
        return true;
    } catch (error) {
        if ([404, 410].includes(Number(error.code || error.response?.status))) {
            console.warn('[Google Calendar] Event already missing:', googleEventId);
            return true;
        }
        console.error('[Google Calendar] Delete error:', error.message);
        return false;
    }
}

export async function getEventStatus(googleEventId, target = {}) {
    const calendarId = target.calendarId || defaultCalendarId;
    if (!calendarId || !googleEventId) return { available: false, reason: 'disabled' };

    try {
        const res = await calendar.events.get({
            calendarId,
            eventId: googleEventId,
        });

        return {
            available: res.data.status !== 'cancelled',
            status: res.data.status || 'confirmed',
            reason: res.data.status === 'cancelled' ? 'cancelled' : 'found',
        };
    } catch (error) {
        if ([404, 410].includes(Number(error.code || error.response?.status))) {
            return { available: false, reason: 'missing' };
        }
        console.error('[Google Calendar] Status check error:', error.message);
        return { available: null, reason: 'error', error: error.message };
    }
}

// Helper
function capitalize(str = '') {
    return str.charAt(0).toUpperCase() + str.slice(1);
}
