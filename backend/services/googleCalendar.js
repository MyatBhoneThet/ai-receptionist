import { google } from 'googleapis';
import 'dotenv/config';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const calendarId = process.env.GOOGLE_CALENDAR_ID;

// Fix private key formatting safely
const processedKey = process.env.GOOGLE_PRIVATE_KEY
    ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : null;

// Validate env early
if (!calendarId || !process.env.GOOGLE_CLIENT_EMAIL || !processedKey) {
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

    if (typeof date === 'string') return date;

    const d = new Date(date);
    if (isNaN(d)) return null;

    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
}

// Build ISO datetime safely WITHOUT shifting timezone incorrectly
function buildDateTime(dateStr, timeStr) {
    const time = timeStr || '12:00:00';
    return `${dateStr}T${time}`;
}

// Create or update event
export async function upsertEvent(booking) {
    if (!calendarId || !processedKey) return null;

    try {
        const {
            id,
            service_type,
            date,
            end_date,
            start_time,
            end_time,
            people,
            location,
            notes,
            google_event_id,
        } = booking;

        const startDateStr = formatDateLocal(date);
        const endDateStr = formatDateLocal(end_date) || startDateStr;

        if (!startDateStr) {
            console.error('[Google Calendar] Invalid start date');
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

        // Simple check: if end <= start on the same day OR if start > end across days
        if (new Date(finalEndTime) <= new Date(finalStartTime)) {
            console.log('[Google Calendar] Adjusting invalid time range...');
            const startDT = new Date(finalStartTime);
            const adjustedEndDT = new Date(startDT.getTime() + 60 * 60 * 1000); // Default to +1 hour

            // Format back to YYYY-MM-DDTHH:MM (local-ish, since we don't shift TZ here)
            const year = adjustedEndDT.getFullYear();
            const month = String(adjustedEndDT.getMonth() + 1).padStart(2, '0');
            const day = String(adjustedEndDT.getDate()).padStart(2, '0');
            const hours = String(adjustedEndDT.getHours()).padStart(2, '0');
            const minutes = String(adjustedEndDT.getMinutes()).padStart(2, '0');
            finalEndTime = `${year}-${month}-${day}T${hours}:${minutes}`;
        }

        const event = {
            summary,
            location: location || '',
            description,
            start: {
                dateTime: finalStartTime,
                timeZone: 'Asia/Bangkok', // 🔥 FIX: use your real timezone
            },
            end: {
                dateTime: finalEndTime,
                timeZone: 'Asia/Bangkok',
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
        if (error.code === 404 && booking.google_event_id) {
            console.log('[Google Calendar] Recreating deleted event...');
            return upsertEvent({ ...booking, google_event_id: null });
        }

        return null;
    }
}

// Delete event
export async function cancelEvent(googleEventId) {
    if (!calendarId || !googleEventId) return;

    try {
        await calendar.events.delete({
            calendarId,
            eventId: googleEventId,
        });

        console.log('[Google Calendar] Deleted:', googleEventId);
    } catch (error) {
        console.error('[Google Calendar] Delete error:', error.message);
    }
}

// Helper
function capitalize(str = '') {
    return str.charAt(0).toUpperCase() + str.slice(1);
}