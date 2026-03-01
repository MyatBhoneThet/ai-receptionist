import { google } from 'googleapis';
import 'dotenv/config';

// Initialize the Google Calendar API client
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const calendarId = process.env.GOOGLE_CALENDAR_ID;

const processedKey = process.env.GOOGLE_PRIVATE_KEY
    ?.trim()
    .replace(/^"|"$/g, '') // Strip leading/trailing double quotes
    .replace(/\\n/g, '\n');

const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: processedKey,
    scopes: SCOPES
});

const calendar = google.calendar({ version: 'v3', auth });

/**
 * Formats a Date object as YYYY-MM-DD in LOCAL time.
 * @param {Date} date 
 * @returns {string}
 */
function formatDateLocal(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Creates or updates a Google Calendar event for a booking.
 * @param {Object} booking - The booking object from the database.
 * @returns {Promise<string>} - The Google Event ID.
 */
export async function upsertEvent(booking) {
    if (!calendarId || !process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
        console.warn('[Google Calendar] Missing credentials, skipping sync.');
        return null;
    }

    const {
        id,
        service_type,
        date,
        end_date, // Support for check-out date
        start_time,
        end_time,
        people,
        location,
        notes,
        google_event_id,
    } = booking;

    const summary = `AI Receptionist: ${service_type.charAt(0).toUpperCase() + service_type.slice(1)} Booking (#${id})`;
    const description = `
Service: ${service_type}
People: ${people}
Notes: ${notes || 'None'}
Internal ID: ${id}
    `.trim();

    // Fix: Format dates locally to prevent UTC shift
    const startDateStr = date instanceof Date ? formatDateLocal(date) : date;
    const endDateStr = (end_date instanceof Date ? formatDateLocal(end_date) : end_date) || startDateStr;

    const startDateTime = `${startDateStr}T${start_time || '12:00:00'}`;
    const endDateTime = `${endDateStr}T${end_time || '13:00:00'}`;

    const event = {
        summary,
        location: location || '',
        description,
        start: {
            dateTime: new Date(startDateTime).toISOString(),
            timeZone: 'UTC',
        },
        end: {
            dateTime: new Date(endDateTime).toISOString(),
            timeZone: 'UTC',
        },
    };

    try {
        if (google_event_id) {
            // Update existing event
            const response = await calendar.events.update({
                auth,
                calendarId,
                eventId: google_event_id,
                resource: event,
            });
            console.log(`[Google Calendar] Event updated: ${response.data.htmlLink}`);
            return google_event_id;
        } else {
            // Create new event
            const response = await calendar.events.insert({
                auth,
                calendarId,
                resource: event,
            });
            console.log(`[Google Calendar] Event created: ${response.data.htmlLink}`);
            return response.data.id;
        }
    } catch (error) {
        console.error('[Google Calendar] Error syncing event:', error.message);
        if (error.code === 404 && google_event_id) {
            // If event was deleted manually, try creating it again
            console.log('[Google Calendar] Event not found, creating a new one...');
            const response = await calendar.events.insert({
                auth,
                calendarId,
                resource: event,
            });
            return response.data.id;
        }
        return null; // Don't block the main flow if calendar sync fails
    }
}

/**
 * Cancels (deletes) a Google Calendar event.
 * @param {string} googleEventId - The Google Event ID to delete.
 */
export async function cancelEvent(googleEventId) {
    if (!calendarId || !googleEventId) return;

    try {
        await calendar.events.delete({
            auth,
            calendarId,
            eventId: googleEventId,
        });
        console.log(`[Google Calendar] Event deleted: ${googleEventId}`);
    } catch (error) {
        console.error('[Google Calendar] Error deleting event:', error.message);
    }
}
