'use client';

import { confirmBooking } from '../lib/api.js';

export default function ConfirmModal({ sessionId, summary, onConfirm, onCancel }) {
    if (!summary) return null;

    const handleConfirm = async () => {
        try {
            await confirmBooking(sessionId);
            onConfirm();
        } catch (err) {
            console.error('[ConfirmModal] Confirm error:', err);
            onConfirm();
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm animate-fade-in" role="dialog" aria-modal="true">
            <div className="glass-card w-full max-w-md overflow-hidden rounded-3xl shadow-2xl animate-fade-in delay-100 border border-slate-700/50">
                <div className="bg-primary-600/10 p-8 text-center border-b border-slate-800/50">
                    <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-600 text-3xl shadow-lg shadow-primary-500/20">
                        ✅
                    </div>
                    <h2 className="text-xl font-bold text-white">Confirm your booking?</h2>
                    <p className="mt-1 text-sm text-slate-400">Please review the details below</p>
                </div>

                <div className="p-8">
                    <div className="space-y-4 rounded-2xl bg-slate-950/50 p-5 ring-1 ring-slate-800/50">
                        {[
                            { label: 'Service', value: summary.service_type },
                            { label: 'Date', value: summary.date },
                            { label: 'Time', value: summary.start_time ? `${summary.start_time}${summary.end_time ? ` – ${summary.end_time}` : ''}` : null },
                            { label: 'Guests', value: summary.people },
                            { label: 'Location', value: summary.location },
                            { label: 'Notes', value: summary.notes },
                        ].map((item) => item.value && (
                            <div key={item.label} className="flex justify-between items-center text-sm">
                                <span className="text-slate-500 font-medium">{item.label}</span>
                                <span className="text-slate-200 font-bold">{String(item.value)}</span>
                            </div>
                        ))}
                    </div>

                    <div className="mt-8 flex gap-3">
                        <button
                            className="flex-1 rounded-xl bg-slate-800 py-3.5 text-sm font-bold text-slate-300 transition-all hover:bg-slate-700 hover:text-white"
                            onClick={onCancel}
                        >
                            Edit Details
                        </button>
                        <button
                            className="flex-1 rounded-xl bg-primary-600 py-3.5 text-sm font-bold text-white shadow-lg shadow-primary-500/20 transition-all hover:bg-primary-500 active:scale-95"
                            onClick={handleConfirm}
                        >
                            Confirm Booking
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

