import axios from 'axios';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

const api = axios.create({
    baseURL: BASE_URL,
    headers: { 'Content-Type': 'application/json' },
});

/**
 * Send a chat message
 * @param {string} session_id
 * @param {string} message
 */
export async function sendMessage(session_id, message) {
    const { data } = await api.post('/api/chat', { session_id, message });
    return data;
}

/**
 * Confirm the pending booking for a session
 * @param {string} session_id
 */
export async function confirmBooking(session_id) {
    const { data } = await api.post('/api/chat/confirm', { session_id });
    return data;
}

/**
 * Get all bookings for a session
 * @param {string} session_id
 */
export async function getBookings(session_id) {
    const { data } = await api.get(`/api/bookings/${session_id}`);
    return data;
}

/**
 * Cancel a booking by ID
 * @param {number} id
 */
export async function cancelBooking(id) {
    const { data } = await api.delete(`/api/bookings/${id}`);
    return data;
}
