import type { ServiceType, OperationalStatus } from './api';

export const SERVICE_LABEL: Record<ServiceType, string> = { hotel: 'Hotel rooms', restaurant: 'Restaurant tables', meeting: 'Meeting rooms' };
export const SERVICE_UNIT: Record<ServiceType, string> = { hotel: 'room', restaurant: 'table', meeting: 'meeting room' };
export const SERVICES: ServiceType[] = ['hotel', 'restaurant', 'meeting'];

export const OPERATIONAL_LABEL: Record<OperationalStatus, string> = {
    ready: 'Ready', in_use: 'In use', needs_cleaning: 'Needs cleaning', out_of_service: 'Out of service',
};

export const STATUS_LABEL: Record<string, string> = {
    pending: 'Held — not confirmed', confirmed: 'Confirmed', modified: 'Confirmed (changed)', cancelled: 'Cancelled',
    checked_in: 'In progress', completed: 'Completed', no_show: 'No-show', waitlisted: 'Waitlist — no place held',
    awaiting_confirmation: 'Awaiting confirmation', needs_attention: 'Staff attention required',
};

export function money(amount: string | number | null | undefined, currency: string | null | undefined) {
    if (amount === null || amount === undefined || amount === '') return '—';
    if (!currency) return String(amount);
    try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(amount));
    } catch {
        return `${amount} ${currency}`;
    }
}

export const clock = (value: string | null | undefined) => (value ? String(value).slice(0, 5) : '');

/** An instant shown in the BUSINESS's timezone, not the viewer's. */
export function inZone(value: string | null | undefined, timeZone: string, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }) {
    if (!value) return '—';
    try {
        return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(new Date(value));
    } catch {
        return new Date(value).toLocaleString();
    }
}

export function reservationWhen(reservation: { service_type: string; date: string | null; end_date: string | null; start_time: string | null; end_time: string | null }) {
    if (!reservation.date) return 'No date recorded';
    if (reservation.service_type === 'hotel') return `${reservation.date} → ${reservation.end_date || '?'}`;
    return `${reservation.date} · ${clock(reservation.start_time)}${reservation.end_time ? `–${clock(reservation.end_time)}` : ''}`;
}

export function ago(value: string | null | undefined) {
    if (!value) return 'never';
    const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
    return `${Math.round(seconds / 86400)} d ago`;
}

export function todayIn(timeZone: string) {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

export function nowTimeIn(timeZone: string) {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
}
