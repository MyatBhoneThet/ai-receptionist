'use client';

import React from 'react';
import { checkAvailability } from '../lib/api';
import type { AvailabilityResponse } from '../lib/api';

interface BookingData {
    service_type?: 'restaurant' | 'hotel' | 'meeting' | string;
    date?: string;
    start_time?: string;
    end_time?: string;
    end_date?: string;
    people?: string | number;
    notes?: string;
    preferences?: Record<string, any>;
    [key: string]: any;
}

interface BookingSummaryProps {
    data: BookingData | null;
    missing_fields?: string[];
    intent: string | null;
    confidence: number;
    sessionId?: string;
    sessionToken?: string;
    availability?: AvailabilityResponse;
    onSuggestDate?: (date: string) => void;
}

const ICONS: Record<string, string> = {
    restaurant: '🍷',
    hotel: '🗝️',
    meeting: '🤝',
};

const SERVICE_LABELS: Record<string, string> = {
    restaurant: 'Restaurant',
    hotel: 'Hotel room',
    meeting: 'Meeting',
};

type SummaryField = {
    key: string;
    label: string;
    placeholder: string;
};

const REQUIRED_FIELDS: Record<string, SummaryField[]> = {
    book_restaurant: [
        { key: 'date', label: 'Date', placeholder: 'Add dining date' },
        { key: 'start_time', label: 'Time', placeholder: 'Add reservation time' },
        { key: 'people', label: 'Guests', placeholder: 'Add party size' },
        { key: 'reservation_name', label: 'Reservation Name', placeholder: 'Add guest name' },
        { key: 'phone_number', label: 'Phone Number', placeholder: 'Add contact number' },
    ],
    book_hotel: [
        { key: 'date', label: 'Check-In', placeholder: 'Add arrival date' },
        { key: 'end_date', label: 'Check-Out', placeholder: 'Add departure date' },
        { key: 'people', label: 'Guests', placeholder: 'Add number of guests' },
        { key: 'reservation_name', label: 'Reservation Name', placeholder: 'Add guest name' },
        { key: 'phone_number', label: 'Phone Number', placeholder: 'Add contact number' },
    ],
    book_meeting: [
        { key: 'date', label: 'Date', placeholder: 'Add meeting date' },
        { key: 'start_time', label: 'Start Time', placeholder: 'Add start time' },
        { key: 'end_time', label: 'End Time', placeholder: 'Add end time' },
        { key: 'people', label: 'Guests', placeholder: 'Add attendee count' },
        { key: 'reservation_name', label: 'Reservation Name', placeholder: 'Add organizer name' },
        { key: 'phone_number', label: 'Phone Number', placeholder: 'Add contact number' },
    ],
};

const SLIP_FIELDS: SummaryField[] = [
    { key: 'id', label: 'Slip ID', placeholder: 'Not recorded' },
    { key: 'status', label: 'Status', placeholder: 'Not recorded' },
    { key: 'service_type', label: 'Service', placeholder: 'Not recorded' },
    { key: 'date', label: 'Date', placeholder: 'Not recorded' },
    { key: 'end_date', label: 'Check-Out', placeholder: 'Not recorded' },
    { key: 'start_time', label: 'Time', placeholder: 'Not recorded' },
    { key: 'end_time', label: 'End Time', placeholder: 'Not recorded' },
    { key: 'people', label: 'Guests', placeholder: 'Not recorded' },
    { key: 'reservation_name', label: 'Name', placeholder: 'Not recorded' },
    { key: 'phone_number', label: 'Phone Number', placeholder: 'Not recorded' },
    { key: 'notes', label: 'Notes', placeholder: 'Not recorded' },
    { key: 'created_at', label: 'Created', placeholder: 'Not recorded' },
    { key: 'updated_at', label: 'Updated', placeholder: 'Not recorded' },
];

const SEARCH_FIELDS: SummaryField[] = [
    { key: 'service_type', label: 'Reservation Type', placeholder: 'Hotel, restaurant, or meeting?' },
    { key: 'date', label: 'Date', placeholder: 'Which date?' },
    { key: 'reservation_name', label: 'Reservation Name', placeholder: 'Whose reservation?' },
];

function formatSummaryValue(key: string, value: unknown) {
    if (value === null || value === undefined || value === '') return '';
    if (key === 'service_type') return SERVICE_LABELS[String(value)] || String(value);
    if (key === 'date' || key === 'end_date') {
        if (typeof value === 'string') {
            const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
            if (isoMatch) {
                const [, yyyy, mm, dd] = isoMatch;
                return `${dd}-${mm}-${yyyy}`;
            }
            return value.slice(0, 10);
        }
        if (value instanceof Date) {
            const yyyy = value.getFullYear();
            const mm = String(value.getMonth() + 1).padStart(2, '0');
            const dd = String(value.getDate()).padStart(2, '0');
            return `${yyyy}-${mm}-${dd}`;
        }
        return String(value).slice(0, 10);
    }
    if (key === 'created_at' || key === 'updated_at') {
        const text = String(value);
        return text.length >= 19 ? text.slice(0, 19).replace('T', ' ') : text;
    }
    if (key === 'start_time' || key === 'end_time') {
        const text = String(value);
        return text.length >= 5 ? text.slice(0, 5) : text;
    }
    return String(value);
}

export default function BookingSummary({ data, missing_fields = [], intent, confidence, sessionId, sessionToken, availability: availabilityProp, onSuggestDate }: BookingSummaryProps) {
    const [availability, setAvailability] = React.useState<AvailabilityResponse | null>(availabilityProp || null);
    const reservationIntent = ['reservation_slip', 'modify_booking', 'cancel_booking', 'cancel'].includes(intent || '');
    const searchMode = reservationIntent && (data?.modify_step === 'awaiting_lookup' || !(data?.id || data?.edit_booking_id));
    const slipMode = reservationIntent && !searchMode;

    React.useEffect(() => {
        let mounted = true;
        async function fetchAvailability() {
            if (searchMode || !data?.service_type || !data?.date) {
                setAvailability(null);
                return;
            }
            if (availabilityProp) {
                setAvailability(availabilityProp as any);
                return;
            }
            try {
                const result = await checkAvailability({
                    service_type: data.service_type as any,
                    date: data.date,
                    end_date: data.end_date,
                    start_time: data.start_time,
                    end_time: data.end_time,
                    people: data.people,
                    preferred_inventory: data.preferred_inventory,
                    exclude_booking_id: data.id,
                    session_id: sessionId,
                    session_token: sessionToken,
                });
                if (mounted) setAvailability(result);
            } catch (err) {
                // ignore
            }
        }
        fetchAvailability();
        return () => { mounted = false; };
    }, [data?.service_type, data?.date, data?.end_date, data?.start_time, data?.end_time, data?.people, data?.id, data?.preferred_inventory, searchMode, sessionId, sessionToken, availabilityProp]);

    const bookable = ['book_restaurant', 'book_hotel', 'book_meeting'];
    if (!data || !intent || (!bookable.includes(intent) && !reservationIntent)) return null;

    const requiredFields = searchMode ? SEARCH_FIELDS : slipMode ? SLIP_FIELDS : (REQUIRED_FIELDS[intent] || []);
    const icon = ICONS[data.service_type as string] || '📋';
    const pct = Math.round((confidence || 0) * 100);

    return (
        <div className="flex flex-col bg-white rounded-3xl border border-parchment shadow-sm overflow-hidden animate-slide-up">
            {/* Header with Confidence Bar */}
            <div className="relative border-b border-parchment p-6 bg-parchment/30">
                <div className="flex items-center space-x-4 mb-5">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white border border-parchment text-xl shadow-sm">
                        {icon}
                    </div>
                    <div>
                        <h2 className="text-xl font-light text-ink serif lowercase">
                            {slipMode
                                ? 'reservation slip'
                                : searchMode ? 'reservation search'
                                : (data.service_type ? SERVICE_LABELS[data.service_type] || data.service_type : 'reservation')}
                        </h2>
                        <span className="text-[9px] font-bold text-gold uppercase tracking-[0.2em] leading-none">Concierge Summary</span>
                    </div>
                </div>

                {searchMode ? (
                    <p className="text-xs leading-relaxed text-ink/60">
                        No reservation selected yet. These are the details being used to find it.
                    </p>
                ) : <div className="space-y-2">
                    <div className="flex justify-between text-[9px] font-bold uppercase tracking-widest leading-none">
                        <span className="text-ink/30">System Confidence</span>
                        <span className="text-gold">{pct}%</span>
                    </div>
                    <div className="h-[3px] w-full overflow-hidden rounded-full bg-ink/5">
                        <div
                            className="h-full bg-gold transition-all duration-1000 ease-out shimmer-gold"
                            style={{ width: `${pct}%` }}
                        />
                    </div>
                </div>}
            </div>

            {/* Fields List */}
            <div className="flex-1 space-y-5 p-5">
                <div>
                    <div className="mb-3 flex items-center justify-between">
                        <p className="text-[9px] font-bold uppercase tracking-[0.28em] text-ink/40">
                            {searchMode ? 'Search criteria' : slipMode ? 'Reservation Slip' : 'Fill-in-the-blank form'}
                        </p>
                        <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-gold">
                            {searchMode ? 'Unverified' : slipMode ? 'Saved details' : `${requiredFields.filter((field) => !data[field.key]).length} blanks left`}
                        </span>
                    </div>

                    <div className="divide-y divide-ink/10 border-y border-ink/10">
                        {requiredFields.map(({ key, label, placeholder }) => {
                            const rawValue = data[key];
                            const displayValue = formatSummaryValue(key, rawValue);
                            const hasValue = Boolean(displayValue);
                            const isMissing = slipMode ? !hasValue : (missing_fields.includes(key) || !hasValue);

                            return (
                                <div
                                    key={key}
                                    className="group flex items-baseline justify-between gap-4 py-3.5"
                                >
                                    <div className="min-w-0">
                                        <span className={`block text-[9px] font-bold uppercase tracking-widest leading-none mb-1.5 ${isMissing ? 'text-rose-500' : 'text-ink/30'}`}>
                                            {label}
                                        </span>
                                        <span className={`block truncate text-xs font-bold serif ${isMissing ? 'text-rose-700' : 'text-ink'}`}>
                                            {hasValue ? displayValue : placeholder}
                                        </span>
                                    </div>
                                    <span className={`shrink-0 text-[9px] font-bold uppercase tracking-widest ${isMissing ? 'text-rose-400' : 'text-gold'}`}>
                                        {isMissing ? 'Missing' : (slipMode ? 'Saved' : 'Set')}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {!searchMode && data.preferences && Object.keys(data.preferences).length > 0 && (
                    <div className="mt-3 rounded-xl border border-parchment p-4 bg-parchment/40">
                        <p className="text-[9px] font-bold uppercase tracking-widest text-ink/40 mb-2">Preferences</p>
                        <ul className="space-y-1">
                            {Object.entries(data.preferences).map(([k, v]) => (
                                <li key={k} className="text-xs text-ink/80">
                                    <span className="font-semibold">{k}:</span> {String(v)}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {!searchMode && availability && (
                    <div className="mt-3 rounded-xl border border-ink/10 p-4 bg-white flex items-center justify-between">
                        <div>
                            <p className="text-[9px] uppercase tracking-widest text-ink/40 font-bold">Availability</p>
                            <p className="text-sm text-ink font-bold">
                                {availability.available ?? 0}/{availability.total ?? 0} available
                            </p>
                            {availability.selected_option && (
                                <p className="mt-1 text-[11px] text-ink/60">
                                    {availability.selected_option.name || availability.selected_option.code} · capacity {availability.selected_option.capacity}
                                </p>
                            )}
                        </div>
                        {availability.waitlist ? (
                            <span className="px-3 py-1 rounded-full bg-rose-50 text-rose-600 text-[11px] font-bold uppercase tracking-widest">Waitlist</span>
                        ) : (
                            <span className="px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-bold uppercase tracking-widest">Open</span>
                        )}
                    </div>
                )}

                {!searchMode && availability?.waitlist && availability?.alternative && (() => {
                    const alternative = availability.alternative;
                    return (
                    <div className="mt-2 rounded-xl border border-amber-100 bg-amber-50 p-3 space-y-2">
                        <p className="text-[10px] uppercase tracking-widest text-amber-700 font-bold">Next available</p>
                        <p className="text-sm text-ink font-semibold">
                            {alternative.date} · {alternative.available}/{alternative.total} open
                        </p>
                        {alternative.selected_option && (
                            <p className="text-xs text-amber-800/80">
                                {alternative.selected_option.name || 'Available option'} · capacity {alternative.selected_option.capacity}
                            </p>
                        )}
                        {alternative.start_time && (
                            <p className="text-xs text-amber-800/80">
                                {String(alternative.start_time).slice(0, 5)}
                                {alternative.end_time ? `-${String(alternative.end_time).slice(0, 5)}` : ''}
                            </p>
                        )}
                        {onSuggestDate && (
                            <button
                                className="rounded-full bg-ink text-white px-4 py-2 text-[11px] font-bold uppercase tracking-widest hover:scale-[1.01]"
                                onClick={() => onSuggestDate(alternative.date)}
                            >
                                {alternative.recommendation_type === 'place'
                                    ? 'Use this option'
                                    : alternative.recommendation_type === 'time'
                                        ? 'Switch to this time'
                                        : 'Switch to this date'}
                            </button>
                        )}
                    </div>
                    );
                })()}
            </div>

            <div className="p-5 pt-0">
                 <div className="rounded-xl bg-ink p-4 flex items-center justify-between group cursor-help">
                    <div className="flex flex-col">
                        <span className="text-[9px] font-bold text-white/40 uppercase tracking-widest leading-none mb-1">Status</span>
                        <span className="text-[11px] font-bold text-white uppercase tracking-tighter">
                            {searchMode ? 'No reservation selected' : slipMode ? 'Reservation Slip' : 'Drafting Request'}
                        </span>
                    </div>
                    <div className="h-2 w-2 rounded-full bg-gold animate-pulse shadow-[0_0_8px_rgba(201,169,110,0.5)]" />
                 </div>
            </div>
        </div>
    );
}
