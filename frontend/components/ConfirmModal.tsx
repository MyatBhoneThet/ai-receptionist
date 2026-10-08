'use client';

import React from 'react';
import { confirmBooking, ConfirmBookingResponse } from '../lib/api';

interface ConfirmModalProps {
    sessionId: string;
    sessionToken: string;
    summary: any;
    intent: string;
    onConfirm: (response: ConfirmBookingResponse) => void;
    /** Nothing was booked; the reason goes back into the conversation. */
    onFailed?: (response: ConfirmBookingResponse) => void;
    onCancel: () => void;
}

export default function ConfirmModal({ sessionId, sessionToken, summary, intent, onConfirm, onFailed, onCancel }: ConfirmModalProps) {
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState('');
    if (!summary) return null;

    const isCancellation = intent === 'cancel_booking' || intent === 'cancel';
    const isWaitlist = Boolean(summary.draft?.waitlist ?? summary.waitlisted);
    const quote = isCancellation ? null : summary.quote;
    const money = (amount: string) => `${amount} ${quote?.currency || ''}`.trim();
    const typeName = summary.inventory_option?.name || summary.resource_type_name;
    const formatDate = (value: unknown) => {
        if (!value) return '';
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
    };

    const handleConfirm = async () => {
        if (loading || !sessionToken) return;
        setLoading(true);
        setError('');
        try {
            const response = await confirmBooking(sessionId, sessionToken, isCancellation ? 'cancel' : 'confirm', summary.edit_booking_id || summary.id);
            if (!response.success) {
                // Unavailable, changed terms, or the reservation system is down:
                // explain it in the chat rather than leaving a stuck dialog.
                if (onFailed && response.message) { onFailed(response); return; }
                setError(response.message || 'The booking could not be saved. Please try again.');
                return;
            }
            onConfirm(response);
        } catch (err) {
            console.error('[ConfirmModal] Confirm error:', err);
            setError('The booking could not be saved. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-ink/40 backdrop-blur-md animate-fade-in" role="dialog" aria-modal="true">
            <div className="bg-white w-full max-w-lg overflow-hidden rounded-[2rem] shadow-2xl animate-scale-in border border-parchment">
                <div className={`p-10 text-center border-b border-parchment relative overflow-hidden`}>
                    <div className="absolute inset-0 shimmer-gold opacity-30" />
                    <div className={`mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-parchment border border-gold/20 text-4xl shadow-sm relative z-10`}>
                        {isCancellation ? '🍷' : '🥂'}
                    </div>
                    <h2 className="text-3xl font-light text-ink serif lowercase relative z-10">
                        {isCancellation ? 'revisiting your plans?' : isWaitlist ? 'join the waitlist' : 'confirm your selection'}
                    </h2>
                    <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.2em] text-gold relative z-10">
                        {isCancellation ? 'Once cancelled, the reservation is released' : isWaitlist ? 'A waitlist place is not a confirmed booking' : 'Availability is checked again when you confirm'}
                    </p>
                </div>

                <div className="p-10">
                    <div className="space-y-5 p-2">
                        {[
                            { label: 'Service', value: summary.service_type },
                            { label: 'Date', value: formatDate(summary.date) },
                            { label: 'Time', value: summary.start_time ? `${summary.start_time}${summary.end_time ? ` – ${summary.end_time}` : ''}` : null },
                            { label: 'Guests', value: summary.people },
                            { label: 'Name', value: summary.reservation_name },
                            { label: 'Type', value: isCancellation || isWaitlist ? null : typeName },
                            { label: 'Total', value: quote && Number(quote.total) > 0 ? money(quote.total) : null },
                            { label: 'Minimum spend', value: quote && Number(quote.minimum_spend) > 0 ? money(quote.minimum_spend) : null },
                            { label: 'Deposit (arranged by staff)', value: quote?.deposit?.required ? money(quote.deposit.amount) : null },
                        ].map((item) => item.value && (
                            <div key={item.label} className="flex justify-between items-baseline border-b border-ink/5 pb-2 last:border-0 last:pb-0">
                                <span className="text-[10px] font-bold uppercase tracking-widest text-ink/30 serif">{item.label}</span>
                                <span className="text-sm font-bold text-ink serif">{String(item.value)}</span>
                            </div>
                        ))}
                    </div>

                    {error && <p className="mt-6 text-sm text-red-700" role="alert">{error}</p>}
                    <div className="mt-10 flex gap-4">
                        <button
                            className="flex-1 rounded-full border border-ink/10 py-5 text-[11px] font-bold uppercase tracking-widest text-ink/40 transition-all hover:bg-parchment hover:text-ink disabled:opacity-50"
                            onClick={onCancel}
                            disabled={loading}
                        >
                            {isCancellation ? 'keep booking' : 'amend details'}
                        </button>
                        <button
                            className={`flex-1 rounded-full ${isCancellation ? 'bg-ink' : 'bg-gold shadow-lg shadow-gold/20'} py-5 text-[11px] font-bold uppercase tracking-widest text-ink transition-all hover:scale-105 active:scale-95 disabled:opacity-50`}
                            onClick={handleConfirm}
                            disabled={loading || !sessionToken}
                        >
                            {loading ? 'Processing...' : (isCancellation ? 'Cancel Reservation' : isWaitlist ? 'Join Waitlist' : 'Complete Booking')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
