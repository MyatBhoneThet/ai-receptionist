'use client';

import { useEffect, useState } from 'react';
import { getAllBookings, fetchMe } from '../../lib/api';

export default function CalendarPage() {
  const [bookings, setBookings] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [userEmail, setUserEmail] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const stored = typeof window !== 'undefined' ? localStorage.getItem('ai_receptionist_auth_token') || undefined : undefined;
        if (stored) {
          const me = await fetchMe(stored);
          setUserEmail(me.email);
        }
        const b = await getAllBookings(stored, { limit: 200 });
        setBookings(b);
      } catch (err: any) {
        setError(err?.response?.data?.error || 'Failed to load bookings');
      }
    })();
  }, []);

  const grouped = groupByDate(bookings);

  return (
    <main className="min-h-screen bg-gradient-to-b from-white to-parchment">
      <header className="px-10 py-6 flex items-center justify-between border-b border-parchment">
        <div>
          <p className="text-xs uppercase font-bold tracking-widest text-ink/50">Calendar</p>
          <h1 className="text-3xl font-bold text-ink">Bookings</h1>
        </div>
        <p className="text-xs text-ink/60">{userEmail}</p>
      </header>

      <section className="px-10 py-8 grid md:grid-cols-3 lg:grid-cols-4 gap-4">
        {Object.entries(grouped).map(([date, items]) => (
          <div key={date} className="rounded-2xl border border-parchment bg-white p-4 shadow-sm">
            <p className="text-[11px] uppercase tracking-widest font-bold text-ink/50">{date}</p>
            <p className="text-2xl font-bold text-ink mt-1">{items.length}</p>
            <div className="mt-3 space-y-2 max-h-64 overflow-auto">
              {items.map((b) => (
                <div key={b.id} className="rounded-xl border border-parchment px-3 py-2">
                  <p className="text-sm font-bold text-ink">{b.reservation_name || 'Guest'}</p>
                  <p className="text-xs text-ink/60">{b.service_type} · {b.start_time ? b.start_time.slice(0,5) : '—'} · {b.status}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
        {Object.keys(grouped).length === 0 && <p className="text-sm text-ink/60">No bookings yet.</p>}
      </section>

      {error && <p className="text-sm text-red-600 px-10 pb-6">{error}</p>}
    </main>
  );
}

function groupByDate(bookings: any[]) {
  return bookings.reduce((acc: Record<string, any[]>, b) => {
    const key = (b.date || '').slice(0, 10);
    if (!key) return acc;
    if (!acc[key]) acc[key] = [];
    acc[key].push(b);
    return acc;
  }, {});
}
