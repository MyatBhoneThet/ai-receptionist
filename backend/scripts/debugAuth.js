import { google } from 'googleapis';
import 'dotenv/config';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

async function testAuth() {
    console.log('--- Auth Test (Object Constructor) ---');
    const email = process.env.GOOGLE_CLIENT_EMAIL;
    const key = process.env.GOOGLE_PRIVATE_KEY
        ?.trim()
        .replace(/^"|"$/g, '')
        .replace(/\\n/g, '\n');

    console.log('Email:', email);
    console.log('Key length:', key?.length);

    try {
        const auth = new google.auth.JWT({
            email: email,
            key: key,
            scopes: SCOPES
        });

        console.log('Auth key set?', !!auth.key);
        console.log('Requesting access token...');
        const token = await auth.getAccessToken();
        console.log('✅ Access Token obtained!');

        const calendar = google.calendar({ version: 'v3', auth });
        console.log('Listing calendars...');
        const res = await calendar.calendarList.list();
        console.log('✅ Success! Found ' + (res.data.items?.length || 0) + ' calendars.');
        if (res.data.items) {
            res.data.items.forEach(c => console.log(`- ${c.summary} (${c.id})`));
        }
    } catch (error) {
        console.error('❌ Auth Test Failed:');
        console.error(error.message);
    }
}

testAuth();
