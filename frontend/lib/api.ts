import axios from 'axios';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

const api = axios.create({
    baseURL: BASE_URL,
    headers: { 'Content-Type': 'application/json' },
});

export interface BookingData {
    service_type?: 'restaurant' | 'hotel' | 'meeting' | string;
    date?: string;
    start_time?: string;
    end_time?: string;
    people?: string | number;
    location?: string;
    notes?: string;
    [key: string]: any;
}

export interface ChatResponse {
    message: string;
    data: BookingData | null;
    intent: string;
    missing_fields?: string[];
    confidence: number;
    speak?: string;
}

/**
 * Send a chat message
 */
export async function sendMessage(session_id: string, message: string): Promise<ChatResponse> {
    const { data } = await api.post<ChatResponse>('/api/chat', { session_id, message });
    return data;
}

/**
 * Confirm the pending booking for a session
 */
export async function confirmBooking(session_id: string, action?: 'confirm' | 'cancel'): Promise<any> {
    const { data } = await api.post('/api/chat/confirm', { session_id, action });
    return data;
}

/**
 * Get all bookings for a session
 */
export async function getBookings(session_id: string): Promise<any[]> {
    const { data } = await api.get<any[]>(`/api/bookings/${session_id}`);
    return data;
}

/**
 * Cancel a booking by ID
 */
export async function cancelBooking(id: number): Promise<any> {
    const { data } = await api.delete(`/api/bookings/${id}`);
    return data;
}
