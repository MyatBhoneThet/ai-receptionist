import { upsertEvent, cancelEvent } from '../services/googleCalendar.js';
import 'dotenv/config';

async function testSync() {
    console.log('🧪 Testing Google Calendar Sync...');

    try {
        console.log('0. Testing Authentication...');
        // We need to import the auth object or re-create it similar to the service
        // For simplicity, let's just log the keys length
        console.log('Email length:', process.env.GOOGLE_CLIENT_EMAIL?.length);
        console.log('Key length:', process.env.GOOGLE_PRIVATE_KEY?.length);
        console.log('Calendar ID:', process.env.GOOGLE_CALENDAR_ID);
    } catch (authError) {
        console.error('❌ Auth debug failed:', authError.message);
    }
    const mockBooking = {
        id: 999,
        service_type: 'meeting',
        date: '2026-03-05',
        start_time: '10:00:00',
        end_time: '11:00:00',
        people: 2,
        location: 'Conference Room A',
        notes: 'Test meeting from script',
        google_event_id: null
    };

    try {
        console.log('1. Testing event creation...');
        const eventId = await upsertEvent(mockBooking);

        if (eventId) {
            console.log(`✅ Event created successfully! ID: ${eventId}`);
            mockBooking.google_event_id = eventId;

            console.log('2. Testing event update...');
            mockBooking.notes = 'Updated test meeting notes';
            const updatedId = await upsertEvent(mockBooking);

            if (updatedId === eventId) {
                console.log('✅ Event updated successfully!');

                console.log('3. Testing event deletion...');
                await cancelEvent(eventId);
                console.log('✅ Event deleted successfully!');
            } else {
                console.error('❌ Event ID mismatch after update');
            }
        } else {
            console.log('⚠️ Event sync skipped or failed (check credentials in .env)');
        }
    } catch (error) {
        console.error('❌ Test failed:', error);
    }
}

testSync();
