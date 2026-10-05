import axios from 'axios';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

const api = axios.create({
    baseURL: BASE_URL,
    headers: { 'Content-Type': 'application/json' },
    withCredentials: true,
});

const ENABLE_LOCALSTORAGE_AUTH_FALLBACK = process.env.NEXT_PUBLIC_ENABLE_LOCALSTORAGE_AUTH_FALLBACK !== 'false';

function adminHeaders(token?: string) {
    const headers: Record<string, string> = {};
    if (token) {
        headers.Authorization = `Bearer ${token}`;
        headers['X-Admin-Token'] = token;
    }
    return headers;
}

export interface BookingData {
    service_type?: 'restaurant' | 'hotel' | 'meeting' | string;
    date?: string;
    start_time?: string;
    end_time?: string;
    people?: string | number;
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
    session_token?: string;
    availability?: AvailabilityResponse;
    show_reservation_slip?: boolean;
}

export interface ConfirmBookingResponse {
    success: boolean;
    message: string;
    booking_id?: number;
    session_token?: string;
    calendar_sync?: { status: 'synced' | 'failed' | 'disabled' };
}

export interface InventoryOption {
    id: number;
    category: string;
    code: string;
    name?: string;
    capacity: number;
    quantity: number;
    available: number;
}

export interface AvailabilityResponse {
    available: number;
    total: number;
    waitlist: boolean;
    reason?: string;
    selected_option?: InventoryOption | null;
    occupied_option?: InventoryOption | null;
    place_recommendation?: InventoryOption | null;
    options?: InventoryOption[];
    other_options?: InventoryOption[];
    alternative?: {
        date: string;
        end_date?: string;
        start_time?: string;
        end_time?: string;
        available: number;
        total: number;
        selected_option?: InventoryOption | null;
        recommendation_type?: 'place' | 'time' | 'date' | string;
    } | null;
}

export interface User {
    id: number;
    email: string;
    name?: string;
    phone_number?: string;
    role: 'customer' | 'staff' | 'admin';
    preferences?: Record<string, any>;
}

export interface AuthResponse {
    token: string;
    user: User;
}

/**
 * Auth
 */
export async function register(input: { email: string; password: string; name?: string; phone_number?: string }): Promise<AuthResponse> {
    const { data } = await api.post<AuthResponse>('/api/users/register', input);
    return data;
}

export async function login(input: { email: string; password: string }): Promise<AuthResponse> {
    const { data } = await api.post<AuthResponse>('/api/users/login', input);
    return data;
}

export async function logout(): Promise<void> {
    await api.post('/api/users/logout');
}

export async function fetchMe(token?: string): Promise<User> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const { data } = await api.get<User>('/api/users/me', { headers });
    return data;
}

export async function savePreferences(payload: {
  dietary?: string;
  room_type?: string;
  favorite_table?: string;
  vip_notes?: string;
}, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const { data } = await api.patch('/api/users/me/preferences', payload, { headers });
  return data;
}

/**
 * Send a chat message
 */
export async function sendMessage(session_id: string, message: string): Promise<ChatResponse> {
    const auth_token = ENABLE_LOCALSTORAGE_AUTH_FALLBACK && typeof window !== 'undefined'
      ? localStorage.getItem('ai_receptionist_auth_token')
      : null;
    const { data } = await api.post<ChatResponse>('/api/chat', { session_id, message, auth_token });
    return data;
}

/**
 * Clear conversation history while keeping the session's reservations accessible.
 */
export async function resetConversation(session_id: string, session_token: string): Promise<void> {
    await api.post('/api/chat/reset', { session_id, session_token }, {
        headers: {
            'X-Session-Id': session_id,
            'X-Session-Token': session_token,
        },
    });
}

/**
 * Confirm the pending booking for a session
 */
export async function confirmBooking(session_id: string, session_token: string, action?: 'confirm' | 'cancel', booking_id?: string | number): Promise<ConfirmBookingResponse> {
    const { data } = await api.post<ConfirmBookingResponse>('/api/chat/confirm', { session_id, session_token, action, booking_id }, {
        headers: {
            'X-Session-Id': session_id,
            'X-Session-Token': session_token,
        },
    });
    return data;
}

/**
 * Get all bookings for a session
 */
export async function getBookings(session_id: string, session_token: string): Promise<any[]> {
    const { data } = await api.get<any[]>(`/api/bookings/${session_id}`, {
        headers: {
            'X-Session-Id': session_id,
            'X-Session-Token': session_token,
        },
    });
    return data;
}

/**
 * Cancel a booking by ID
 */
export async function cancelBooking(id: number): Promise<any> {
    const { data } = await api.delete(`/api/bookings/${id}`);
    return data;
}

export async function getAllBookings(token?: string, params?: { status?: string; limit?: number }) {
    const headers = adminHeaders(token);
    const { data } = await api.get('/api/bookings', { headers, params });
    return data as any[];
}

export async function updateBookingStatus(id: number, status: string, token?: string) {
    const headers = adminHeaders(token);
    const { data } = await api.post(`/api/bookings/${id}/status`, { status }, { headers });
    return data;
}

export async function syncCalendarDeletions(token?: string) {
    const headers = adminHeaders(token);
    const { data } = await api.post('/api/bookings/sync-calendar', {}, { headers });
    return data as { checked: number; synced: Array<{ id: number; status: string; reason: string }>; errors: any[] };
}

export async function patchBooking(id: number, payload: Record<string, any>, token?: string) {
    const headers = adminHeaders(token);
    const { data } = await api.patch(`/api/bookings/${id}`, payload, { headers });
    return data;
}

/**
 * Availability check
 */
export async function checkAvailability(payload: { service_type: 'restaurant' | 'hotel' | 'meeting'; date: string; end_date?: string; start_time?: string; end_time?: string; people?: string | number; preferred_inventory?: string; exclude_booking_id?: string | number; session_id?: string; session_token?: string }) {
    const headers: Record<string, string> = { };
    if (payload.session_id && payload.session_token) {
        headers['X-Session-Id'] = payload.session_id;
        headers['X-Session-Token'] = payload.session_token;
    }
    const { data } = await api.post('/api/availability/check', payload, { headers });
    return data as AvailabilityResponse;
}

// --- Admin / analytics ---

export async function getAnalyticsSummary(token?: string) {
    const headers = adminHeaders(token);
    const { data } = await api.get('/api/analytics/summary', { headers });
    return data;
}

export async function getAnalyticsTimeseries(token?: string) {
    const headers = adminHeaders(token);
    const { data } = await api.get('/api/analytics/timeseries', { headers });
    return data as { date: string; bookings: number }[];
}

export async function getRecentBookings(token?: string) {
    const headers = adminHeaders(token);
    const { data } = await api.get('/api/analytics/recent', { headers });
    return data;
}

// Inventory (admin)
export async function listInventory(token?: string) {
    const headers = adminHeaders(token);
    const { data } = await api.get('/api/inventory', { headers });
    return data as any[];
}

export async function upsertInventory(item: { category: 'room' | 'table' | 'meeting'; code: string; name?: string; capacity?: number; quantity?: number; metadata?: Record<string, any> }, token?: string) {
    const headers = adminHeaders(token);
    const { data } = await api.post('/api/inventory', item, { headers });
    return data;
}

export interface NotificationSettings {
    provider: 'slack' | 'teams';
    webhook_url: string;
    alert_email: string;
}

export async function getNotificationSettings(token?: string) {
    const headers = adminHeaders(token);
    const { data } = await api.get<NotificationSettings>('/api/settings/notifications', { headers });
    return data;
}

export async function saveNotificationSettings(payload: NotificationSettings, token?: string) {
    const headers = adminHeaders(token);
    const { data } = await api.patch<NotificationSettings>('/api/settings/notifications', payload, { headers });
    return data;
}

export interface AuditLog {
    id: number;
    actor_email: string | null;
    action: string;
    entity: string;
    before_state: Record<string, any>;
    after_state: Record<string, any>;
    created_at: string;
    change_summary?: { field: string; before: any; after: any }[];
}

export async function getAuditLogs(token?: string, limit = 20, entity?: string) {
    const headers = adminHeaders(token);
    const { data } = await api.get<AuditLog[]>('/api/settings/audit', {
        headers,
        params: { limit, entity },
    });
    return data;
}
