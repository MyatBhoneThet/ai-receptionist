'use client';

const LABELS = {
    service_type: 'Service',
    date: 'Date',
    start_time: 'Start Time',
    end_time: 'End Time',
    people: 'Guests',
    location: 'Location',
    notes: 'Notes',
};

const ICONS = {
    restaurant: '🍽️',
    hotel: '🏨',
    meeting: '📅',
};

export default function BookingSummary({ data, missing_fields = [], intent, confidence }) {
    const bookable = ['book_restaurant', 'book_hotel', 'book_meeting'];
    if (!data || !intent || !bookable.includes(intent)) return null;

    const icon = ICONS[data.service_type] || '📋';
    const pct = Math.round((confidence || 0) * 100);

    return (
        <div className="glass-card flex flex-col overflow-hidden rounded-2xl animate-fade-in">
            {/* Header with Confidence Bar */}
            <div className="relative border-b border-slate-800/50 bg-slate-900/40 p-5">
                <div className="flex items-center space-x-4 mb-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-800 text-2xl shadow-inner">
                        {icon}
                    </div>
                    <div>
                        <h2 className="text-sm font-bold tracking-tight text-white uppercase">
                            {data.service_type
                                ? data.service_type.charAt(0).toUpperCase() + data.service_type.slice(1)
                                : 'Booking Details'}
                        </h2>
                        <span className="text-[10px] font-medium text-slate-500 uppercase tracking-widest">Live Extraction</span>
                    </div>
                </div>

                <div className="space-y-1.5">
                    <div className="flex justify-between text-[10px] font-bold uppercase tracking-wider">
                        <span className="text-slate-400">AI Confidence</span>
                        <span className={pct >= 85 ? 'text-emerald-400' : pct >= 60 ? 'text-amber-400' : 'text-rose-400'}>{pct}%</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800/50">
                        <div
                            className={`h-full transition-all duration-1000 ease-out ${pct >= 85 ? 'bg-gradient-to-r from-emerald-500 to-teal-400' :
                                    pct >= 60 ? 'bg-gradient-to-r from-amber-500 to-orange-400' :
                                        'bg-gradient-to-r from-rose-500 to-pink-500'
                                }`}
                            style={{ width: `${pct}%` }}
                        />
                    </div>
                </div>
            </div>

            {/* Fields List */}
            <div className="flex-1 space-y-1 p-4 overflow-y-auto">
                {Object.entries(LABELS).map(([key, label]) => {
                    const val = data[key];
                    const missing = missing_fields.includes(key);
                    if (!val && !missing) return null;

                    return (
                        <div key={key} className={`group flex items-center justify-between rounded-lg px-3 py-2.5 transition-colors ${missing ? 'bg-rose-500/5 border border-rose-500/10' : 'hover:bg-white/5'}`}>
                            <div className="flex flex-col">
                                <span className={`text-[10px] font-bold uppercase tracking-wider ${missing ? 'text-rose-400' : 'text-slate-500'}`}>
                                    {label}
                                </span>
                                <span className={`text-sm font-medium ${missing ? 'text-rose-300 italic' : 'text-slate-200'}`}>
                                    {missing ? 'Required' : String(val)}
                                </span>
                            </div>
                            {!missing && (
                                <div className="h-5 w-5 rounded-full bg-emerald-500/10 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                    <svg className="h-3 w-3 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                    </svg>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

