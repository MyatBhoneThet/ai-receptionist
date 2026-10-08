import axios from 'axios';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

const api = axios.create({
    baseURL: BASE_URL,
    headers: { 'Content-Type': 'application/json' },
    withCredentials: true,
});

const ENABLE_LOCALSTORAGE_AUTH_FALLBACK = process.env.NEXT_PUBLIC_ENABLE_LOCALSTORAGE_AUTH_FALLBACK !== 'false';

// ── Guest side: which business this chat is talking to ───────────────────────
// The public booking identifier comes from the page URL (?business=…) or the
// build-time default. The backend binds the session token to that business.
let guestBusiness = process.env.NEXT_PUBLIC_DEFAULT_BUSINESS_SLUG || '';
export function setGuestBusiness(slug: string) { guestBusiness = slug || ''; }
export function getGuestBusiness() { return guestBusiness; }
const guestHeaders = (extra: Record<string, string> = {}) => (guestBusiness ? { ...extra, 'X-Business': guestBusiness } : extra);

// ── Staff side: signed-in dashboard requests ─────────────────────────────────
export function getAuthToken(): string | undefined {
    if (typeof window === 'undefined' || !ENABLE_LOCALSTORAGE_AUTH_FALLBACK) return undefined;
    return localStorage.getItem('ai_receptionist_auth_token') || undefined;
}
function authHeaders(): Record<string, string> {
    const token = getAuthToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
}

/** The backend's structured error: { error: { code, message, details } }. */
export interface ApiError { code: string; message: string; details: Record<string, any>; status?: number }
export function toApiError(err: any): ApiError {
    const data = err?.response?.data;
    const status = err?.response?.status;
    if (data?.error && typeof data.error === 'object') return { ...data.error, details: data.error.details || {}, status };
    if (typeof data?.error === 'string') return { code: 'error', message: data.error, details: {}, status };
    if (!err?.response) return { code: 'network', message: 'The server could not be reached. Check your connection and try again.', details: {}, status };
    return { code: 'error', message: err?.message || 'Something went wrong.', details: {}, status };
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
    show_cancel_confirm?: boolean;
    /** True only when the backend has a checked, quotable request (or a waitlist offer) to confirm. */
    requires_confirmation?: boolean;
    availability_error?: string;
}

export interface ConfirmBookingResponse {
    success: boolean;
    message: string;
    booking_id?: number;
    session_token?: string;
    /** confirmed | waitlisted | awaiting_confirmation | cancelled … */
    status?: string;
    /** False for a waitlist place or a request still awaiting the reservation system. */
    confirmed?: boolean;
    code?: string;
    requires_confirmation?: boolean;
    data?: BookingData | null;
    calendar_sync?: { status: 'synced' | 'failed' | 'disabled' | 'not_required' | 'pending' };
}

export interface Money { currency: string }
export interface Quote extends Money {
    lines: { code: string; label: string; unit_amount: string; quantity: number; amount: string }[];
    subtotal: string; booking_fee: string; total: string; minimum_spend: string;
    deposit: { required: boolean; amount: string; rule: Record<string, any>; collection: string };
    policies: Record<string, any>;
    resource_type: { id: number | null; name: string };
    hash: string;
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
    waitlist_possible?: boolean;
    reason_message?: string;
    quote?: Quote | null;
    source?: 'internal' | 'external';
    freshness?: { authoritative: boolean; checked_at: string; cached: boolean };
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
    const auth_token = getAuthToken() || null;
    const { data } = await api.post<ChatResponse>('/api/chat', { session_id, message, auth_token }, { headers: guestHeaders() });
    return data;
}

const sessionHeaders = (session_id: string, session_token: string) => guestHeaders({ 'X-Session-Id': session_id, 'X-Session-Token': session_token });

/**
 * Clear conversation history while keeping the session's reservations accessible.
 */
export async function resetConversation(session_id: string, session_token: string): Promise<void> {
    await api.post('/api/chat/reset', { session_id, session_token }, { headers: sessionHeaders(session_id, session_token) });
}

/**
 * The customer's explicit confirmation. The backend re-checks availability and
 * the quoted terms at this moment; nothing was held while chatting.
 */
export async function confirmBooking(session_id: string, session_token: string, action?: 'confirm' | 'cancel', booking_id?: string | number): Promise<ConfirmBookingResponse> {
    const { data } = await api.post<ConfirmBookingResponse>('/api/chat/confirm', { session_id, session_token, action, booking_id },
        { headers: sessionHeaders(session_id, session_token) });
    return data;
}

/**
 * Get all bookings for a session
 */
export async function getBookings(session_id: string, session_token: string): Promise<any[]> {
    const { data } = await api.get<any[]>(`/api/bookings/${session_id}`, { headers: sessionHeaders(session_id, session_token) });
    return data;
}

export interface PublicBusiness { id: number; name: string; slug: string; timezone: string; currency: string; services: ServiceType[] }
export async function getPublicBusiness(): Promise<PublicBusiness> {
    const { data } = await api.get<PublicBusiness>('/api/bookings/public/business', { headers: guestHeaders() });
    return data;
}

/**
 * Availability check
 */
export async function checkAvailability(payload: { service_type: 'restaurant' | 'hotel' | 'meeting'; date: string; end_date?: string; start_time?: string; end_time?: string; people?: string | number; preferred_inventory?: string; exclude_booking_id?: string | number; session_id?: string; session_token?: string }) {
    const { session_id, session_token, exclude_booking_id, ...request } = payload;
    const { data } = await api.post('/api/availability/check', { ...request, session_id }, {
        headers: session_id && session_token ? sessionHeaders(session_id, session_token) : guestHeaders(),
    });
    return data as AvailabilityResponse;
}

// ═════════════════════════════════════════════════════════════════════════════
// Business dashboard API. Every call is authorised on the server against the
// signed-in user's membership of the business in the URL.
// ═════════════════════════════════════════════════════════════════════════════
export type ServiceType = 'hotel' | 'restaurant' | 'meeting';
export type BookingSource = 'internal' | 'external';
export type Role = 'owner' | 'admin' | 'staff';
export type ConfigSource = 'platform' | 'service' | 'type' | 'resource';

export interface Business {
    id: number; name: string; slug: string; timezone: string; currency: string | null; currency_confirmed: boolean;
    contact_email: string; contact_phone: string; address: string; status: 'setup' | 'active' | 'paused'; is_legacy: boolean;
    role?: Role;
}
export interface Effective { values: Record<string, any>; sources: Record<string, ConfigSource> }
export interface FieldInfo { key: string; label: string }
export interface IntegrationSummary { id: number; name: string; provider_key: string; environment: string; status: string; last_reconciled_at: string | null }
export interface BusinessService {
    service_type: ServiceType; enabled: boolean; booking_source: BookingSource; integration_id: number | null;
    integration: IntegrationSummary | null; settings: Record<string, any>; effective: Effective;
    platform_defaults: Record<string, any>; fields: FieldInfo[];
}
export interface Blocker { code: string; message: string; bookings?: { id: number; reason: string; reservation_name: string }[] }
export interface ActivationReview {
    business_blockers: Blocker[];
    services: { service_type: ServiceType; booking_source: BookingSource; blockers: Blocker[]; ready: boolean }[];
    can_activate: boolean; bookable_services: ServiceType[];
}
export interface BusinessDetail { business: Business; role: Role; services: BusinessService[]; activation: ActivationReview }

export interface ResourceType {
    id: number; service_type: ServiceType; name: string; description: string; code_prefix: string; defaults: Record<string, any>;
    managed_by: BookingSource; is_active: boolean; resource_count?: number; effective: Effective; fields: FieldInfo[];
}
export interface Resource {
    id: number; service_type: ServiceType; resource_type_id: number; resource_type_name: string; code: string; name: string;
    overrides: Record<string, any>; managed_by: BookingSource; is_active: boolean; archived_at: string | null;
    operational_status: OperationalStatus; operational_note: string; effective: Effective; capacity: number;
    legacy: { table: string; id: number } | null;
}
export type OperationalStatus = 'ready' | 'in_use' | 'needs_cleaning' | 'out_of_service';
export interface BatchPreview { service_type: ServiceType; resource_type_id: number; count: number; valid: boolean; items: { code: string; problem: string | null }[] }

export interface Reservation {
    id: number; service_type: ServiceType; status: string; display_status: string; waitlisted: boolean;
    date: string | null; end_date: string | null; start_time: string | null; end_time: string | null; starts_at: string | null; ends_at: string | null;
    people: number | null; layout: string | null; reservation_name: string | null; contact_phone: string | null; contact_email: string | null; notes: string;
    resource: { id: number; code: string; name: string; operational_status: OperationalStatus } | null;
    resource_type: { id: number; name: string } | null;
    source: BookingSource; channel: string; external_reservation_id: string | null; sync_status: string; sync_checked_at: string | null;
    attention_reason: string | null; calendar_sync_status: string; quote: Quote | null; currency: string | null;
    total_amount: string | null; booking_fee_amount: string | null; min_spend_amount: string | null;
    deposit: { amount: string | null; status: string; recorded_at: string | null };
    review_reason: string | null; legacy_review: boolean; created_at: string; updated_at: string;
}
export interface AvailabilityOption {
    resource: { id: number; code: string; name: string } | null; resource_type: { id: number | null; name: string }; capacity: number;
    available: boolean; reason: string | null; message?: string | null; ready_now?: boolean; operational_status?: OperationalStatus; quote?: Quote;
}
export interface Availability {
    service_type: ServiceType; source: BookingSource; freshness: { authoritative: boolean; checked_at: string; cached: boolean };
    provider?: { name: string; is_mock: boolean }; available: number; total: number; reason: { code: string; message: string };
    selected: AvailabilityOption | null; options: AvailabilityOption[]; waitlist_possible: boolean; alternative?: any;
}
export interface MutationResult { reservation: Reservation; calendar_sync?: { status: string }; idempotent_replay?: boolean; promoted?: Reservation[] }

export interface BoardFlag { code: string; message: string; booking_id?: number; resource_id?: number; resource_code?: string; service_type?: ServiceType }
export interface BoardCard {
    id: number; service_type: ServiceType; code: string; name: string; type_name: string; is_active: boolean; managed_by: BookingSource;
    operational_status: OperationalStatus; operational_note: string; operational_updated_at: string | null; operational_updated_by: string | null;
    current: Reservation | null; next: Reservation | null; maintenance: MaintenanceBlock[]; flags: BoardFlag[];
}
export interface MaintenanceBlock { id: number; resource_id: number; starts_at: string; ends_at: string; reason: string }
export interface Board { date: string; timezone: string; generated_at: string; cards: BoardCard[]; schedule: Reservation[]; maintenance: MaintenanceBlock[]; attention: BoardFlag[] }

export interface Integration {
    id: number; provider_key: string; provider_label: string; name: string; environment: string; is_mock: boolean; production_ready: boolean;
    status: 'draft' | 'connected' | 'error' | 'disabled'; capabilities: Record<string, any>; has_credentials: boolean;
    last_tested_at: string | null; last_test_result: { ok: boolean; message: string } | null; last_reconciled_at: string | null; last_error: string | null;
    webhook_secret_once?: string;
}
export interface Member { id: number; user_id: number; email: string; name: string | null; role: Role; created_at: string }

export interface NotificationSettings {
    provider: 'slack' | 'teams';
    webhook_url: string;
    alert_email: string;
}

export interface AuditLog {
    id: number;
    actor_email: string | null;
    action: string;
    entity: string;
    entity_id?: number | string | null;
    before_state: Record<string, any>;
    after_state: Record<string, any>;
    created_at: string;
    change_summary?: { field: string; before: any; after: any }[];
}

async function call<T>(method: 'get' | 'post' | 'patch' | 'delete', path: string, body?: any, params?: Record<string, any>): Promise<T> {
    const { data } = await api.request<T>({ method, url: path, data: body, params, headers: authHeaders() });
    return data;
}

/** A key that makes a create request safe to retry or double-click. */
export function newIdempotencyKey(prefix = 'ui') {
    const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${random}`;
}

export const listMyBusinesses = () => call<Business[]>('get', '/api/businesses');
export const createBusiness = (input: Record<string, any>) => call<Business>('post', '/api/businesses', input);

/** Typed client for one business. */
export function businessApi(businessId: number) {
    const base = `/api/b/${businessId}`;
    return {
        detail: () => call<BusinessDetail>('get', base),
        update: (input: Partial<Business>) => call<Business>('patch', base, input),
        setStatus: (status: 'active' | 'paused') => call<Business>('post', `${base}/status`, { status }),
        review: () => call<{ business: any; items: any[]; blocking: any[] }>('get', `${base}/review`),
        updateService: (service: ServiceType, input: Record<string, any>) => call<BusinessService[]>('patch', `${base}/services/${service}`, input),

        members: () => call<Member[]>('get', `${base}/members`),
        saveMember: (email: string, role: Role) => call('post', `${base}/members`, { email, role }),
        removeMember: (id: number) => call('delete', `${base}/members/${id}`),

        types: (service_type?: ServiceType) => call<ResourceType[]>('get', `${base}/resource-types`, undefined, { service_type }),
        createType: (input: Record<string, any>) => call<ResourceType>('post', `${base}/resource-types`, input),
        updateType: (id: number, input: Record<string, any>) => call<ResourceType>('patch', `${base}/resource-types/${id}`, input),
        archiveType: (id: number) => call('delete', `${base}/resource-types/${id}`),
        resources: (service_type?: ServiceType) => call<Resource[]>('get', `${base}/resources`, undefined, { service_type }),
        previewBatch: (input: Record<string, any>) => call<BatchPreview>('post', `${base}/resources/preview`, input),
        createBatch: (input: Record<string, any>) => call<{ id: number; code: string }[]>('post', `${base}/resources/batch`, input),
        updateResource: (id: number, input: Record<string, any>) => call<Resource>('patch', `${base}/resources/${id}`, input),
        archiveResource: (id: number) => call<{ archived: boolean; deleted: boolean }>('delete', `${base}/resources/${id}`),
        resourceHistory: (id: number) => call<any[]>('get', `${base}/resources/${id}/history`),

        closures: () => call<any[]>('get', `${base}/closures`),
        addClosure: (input: Record<string, any>) => call('post', `${base}/closures`, input),
        removeClosure: (id: number) => call('delete', `${base}/closures/${id}`),

        availability: (input: Record<string, any>) => call<Availability>('post', `${base}/availability`, input),
        reservations: (params?: Record<string, any>) => call<Reservation[]>('get', `${base}/reservations`, undefined, params),
        createReservation: (input: Record<string, any>) => call<MutationResult>('post', `${base}/reservations`, input),
        modifyReservation: (id: number, changes: Record<string, any>, options: Record<string, any> = {}) =>
            call<MutationResult>('patch', `${base}/reservations/${id}`, { changes, options }),
        cancelReservation: (id: number, reason = '') => call<MutationResult>('post', `${base}/reservations/${id}/cancel`, { reason }),
        confirmReservation: (id: number) => call<MutationResult>('post', `${base}/reservations/${id}/confirm`),
        recordDeposit: (id: number, status: string) => call<MutationResult>('post', `${base}/reservations/${id}/deposit`, { status }),

        board: (date?: string, service_type?: ServiceType) => call<Board>('get', `${base}/operations/board`, undefined, { date, service_type }),
        operate: (input: Record<string, any>) => call<MutationResult & { operational_status?: OperationalStatus }>('post', `${base}/operations/actions`, input),
        addMaintenance: (input: Record<string, any>) => call<{ id: number; conflicts: any[] }>('post', `${base}/operations/maintenance`, input),
        removeMaintenance: (id: number) => call('delete', `${base}/operations/maintenance/${id}`),

        integrations: () => call<{ connectors: any[]; integrations: Integration[]; production_connector_available: boolean }>('get', `${base}/integrations`),
        createIntegration: (input: Record<string, any>) => call<Integration>('post', `${base}/integrations`, input),
        testIntegration: (id: number) => call<Integration>('post', `${base}/integrations/${id}/test`),
        importInventory: (id: number) => call<Record<string, any>>('post', `${base}/integrations/${id}/import`),
        mappings: (id: number) => call<any[]>('get', `${base}/integrations/${id}/mappings`),
        integrationHealth: (id: number) => call<{ integration: Integration; events: any[]; unresolved_commands: any[]; attention: any[] }>('get', `${base}/integrations/${id}/health`),
        reconcile: (id: number) => call<Record<string, any>>('post', `${base}/integrations/${id}/reconcile`),
        mock: (id: number) => call<{ settings: any; inventory: any; reservations: any[] }>('get', `${base}/integrations/${id}/mock`),
        updateMock: (id: number, patch: Record<string, any>) => call('patch', `${base}/integrations/${id}/mock`, patch),
        seedMockInventory: (id: number, types: any[]) => call('post', `${base}/integrations/${id}/mock/inventory`, { types }),
        changeMockReservation: (id: number, externalId: string, patch: Record<string, any>) => call('post', `${base}/integrations/${id}/mock/reservations/${externalId}`, patch),
        jobs: () => call<{ counts: Record<string, number>; recent: any[] }>('get', `${base}/sync/jobs`),
        runJobs: () => call<any[]>('post', `${base}/sync/jobs/run`),

        audit: (limit = 50, entity?: string) => call<AuditLog[]>('get', `${base}/audit`, undefined, { limit, entity }),
        notifications: () => call<NotificationSettings>('get', `${base}/settings/notifications`),
        saveNotifications: (input: NotificationSettings) => call<NotificationSettings>('patch', `${base}/settings/notifications`, input),
        calendar: () => call<{ calendar_id: string; enabled: boolean; uses_deployment_calendar: boolean }>('get', `${base}/settings/calendar`),
        saveCalendar: (calendar_id: string) => call<{ calendar_id: string; enabled: boolean }>('patch', `${base}/settings/calendar`, { calendar_id }),
        repairCalendar: () => call<{ enabled: boolean; checked: number; synced: any[]; skipped: any[]; errors: any[] }>('post', `${base}/calendar/repair`, {}),

        analyticsSummary: () => call<{ total_bookings: number; today_bookings: number; cancellations: number; waitlisted: number; by_service: Record<string, number> }>('get', `${base}/analytics/summary`),
        analyticsTimeseries: () => call<{ date: string; bookings: number }[]>('get', `${base}/analytics/timeseries`),
        recent: () => call<Reservation[]>('get', `${base}/analytics/recent`),
    };
}
export type BusinessApi = ReturnType<typeof businessApi>;
