'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  getAnalyticsSummary,
  getAnalyticsTimeseries,
  getRecentBookings,
  fetchMe,
  getAllBookings,
  syncCalendarDeletions,
  updateBookingStatus,
} from '../../lib/api';

interface Summary {
  total_bookings: number;
  today_bookings: number;
  cancellations: number;
  by_service: Record<string, number>;
}

export default function AdminDashboard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [recent, setRecent] = useState<any[]>([]);
  const [timeseries, setTimeseries] = useState<{ date: string; bookings: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [userEmail, setUserEmail] = useState<string>('');
  const [bookings, setBookings] = useState<any[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [syncingCalendar, setSyncingCalendar] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>(''); 
  const [weekView, setWeekView] = useState<{ date: string; items: any[] }[]>([]);

  const getStoredToken = useCallback(() => {
    if (typeof window === 'undefined') return undefined;
    return localStorage.getItem('ai_receptionist_auth_token') || sessionStorage.getItem('ai_receptionist_admin_token') || undefined;
  }, []);

  const loadAdminData = useCallback(async (showSkeleton = false) => {
    if (showSkeleton) setLoading(true);
    setError('');
    const stored = getStoredToken();

    if (stored) {
      try {
        const me = await fetchMe(stored);
        setUserEmail(me.email);
      } catch {
        // identity is optional for rendering the dashboard
      }
    }

    try {
      const [summaryData, timeseriesData, recentData, bookingRows] = await Promise.all([
        getAnalyticsSummary(stored),
        getAnalyticsTimeseries(stored),
        getRecentBookings(stored),
        getAllBookings(stored, { limit: 30, status: statusFilter || undefined }),
      ]);

      setSummary(summaryData);
      setTimeseries(timeseriesData);
      setRecent(recentData);
      setBookings(bookingRows);
      setWeekView(buildWeekView(bookingRows));
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load admin data');
    } finally {
      if (showSkeleton) setLoading(false);
    }
  }, [getStoredToken, statusFilter]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      await loadAdminData(true);
      try {
        const result = await syncCalendarDeletions(getStoredToken());
        if (!cancelled && result.synced?.length) {
          await loadAdminData();
          setError(`Synced ${result.synced.length} deleted Google Calendar booking(s).`);
        }
      } catch {
        // The dashboard should still render if Google Calendar is temporarily unavailable.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [getStoredToken, loadAdminData]);

  const handleStatus = async (id: number, status: string) => {
    setBusyId(id);
    try {
      const stored = getStoredToken();
      const updated = await updateBookingStatus(id, status, stored);
      setBookings((prev) => prev.map((b) => (b.id === id ? updated : b)));
      await loadAdminData();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to update status');
    } finally {
      setBusyId(null);
    }
  };

  const handleCalendarSync = async () => {
    setSyncingCalendar(true);
    setError('');
    try {
      const result = await syncCalendarDeletions(getStoredToken());
      await loadAdminData();
      const syncedCount = result.synced?.length || 0;
      setError(syncedCount ? `Synced ${syncedCount} deleted Google Calendar booking(s).` : 'Calendar sync complete. No deleted bookings found.');
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to sync Google Calendar deletions');
    } finally {
      setSyncingCalendar(false);
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-b from-white to-parchment">
      <header className="flex items-center justify-between px-10 py-6 border-b border-parchment">
        <div>
          <p className="text-xs uppercase tracking-widest text-ink/50 font-bold">Admin</p>
          <h1 className="text-3xl font-bold text-ink">Reception Control Room</h1>
        </div>
        <div className="text-right">
          <p className="text-sm text-ink/60">{userEmail || '—'}</p>
          <div className="flex items-center gap-3 justify-end">
            <a href="/settings" className="text-xs uppercase font-bold text-ink/50 underline">Settings</a>
          </div>
        </div>
      </header>

      {error && (
        <div className="mx-10 mt-4 rounded-xl border border-parchment bg-white px-4 py-3 text-sm font-medium text-ink/70 shadow-sm">
          {error}
        </div>
      )}

      {loading && !summary ? (
        <AdminSkeleton />
      ) : (
      <>
      <section className="px-10 py-6 grid gap-4 md:grid-cols-4">
        {summary ? (
          <>
            <StatCard label="Total bookings" value={summary.total_bookings} />
            <StatCard label="Today" value={summary.today_bookings} />
            <StatCard label="Cancellations" value={summary.cancellations} />
            <StatCard
              label="By service"
              value={`${summary.by_service.restaurant || 0} / ${summary.by_service.hotel || 0} / ${summary.by_service.meeting || 0}`}
              hint="restaurant / hotel / meeting"
            />
          </>
        ) : (
          <p className="col-span-4 text-ink/60 text-sm">Loading metrics… {error}</p>
        )}
      </section>

      <section className="px-10 pb-10 grid gap-6 md:grid-cols-3">
        <div className="rounded-2xl border border-parchment bg-white p-6 shadow-sm md:col-span-2">
          <h2 className="text-lg font-bold text-ink mb-4">Last 7 days</h2>
          <div className="space-y-2">
            {timeseries.map((row) => (
              <div key={row.date} className="flex items-center space-x-3">
                <span className="w-20 text-xs font-mono text-ink/60">{row.date}</span>
                <div className="flex-1 h-2 rounded-full bg-parchment relative">
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-ink"
                    style={{ width: `${Math.min(row.bookings * 10, 100)}%` }}
                  />
                </div>
                <span className="w-8 text-xs text-ink font-bold text-right">{row.bookings}</span>
              </div>
            ))}
            {timeseries.length === 0 && <p className="text-sm text-ink/60">No data yet.</p>}
          </div>
        </div>

        <div className="rounded-2xl border border-parchment bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-ink mb-4">Recent bookings</h2>
          <div className="space-y-3">
            {recent.map((b) => (
              <div key={b.id} className="rounded-xl border border-parchment px-3 py-2">
                <p className="text-sm font-bold text-ink">{b.reservation_name || 'Guest'}</p>
                <p className="text-xs text-ink/60">{b.service_type} · {b.date?.slice(0, 10)} · {b.status}</p>
              </div>
            ))}
            {recent.length === 0 && <p className="text-sm text-ink/60">No recent bookings.</p>}
          </div>
        </div>
      </section>

      <section className="px-10 pb-10">
        <div className="rounded-2xl border border-parchment bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-ink">Calendar (next 7 days)</h2>
            <p className="text-xs text-ink/50">Counts per day with status chips</p>
          </div>
          <div className="grid md:grid-cols-7 gap-3">
            {weekView.map((day) => (
              <div key={day.date} className="rounded-xl border border-parchment p-3 bg-parchment/40">
                <p className="text-[11px] uppercase tracking-widest font-bold text-ink/60">{day.date}</p>
                <p className="text-2xl font-bold text-ink mt-1">{day.items.length}</p>
                <div className="flex flex-wrap gap-1 mt-2">
                  {day.items.slice(0, 4).map((b) => (
                    <span key={b.id} className="px-2 py-1 rounded-full bg-white text-[10px] border border-parchment">
                      {b.service_type} · {b.status}
                    </span>
                  ))}
                  {day.items.length > 4 && (
                    <span className="text-[10px] text-ink/60">+{day.items.length - 4} more</span>
                  )}
                </div>
              </div>
            ))}
            {weekView.length === 0 && <p className="text-sm text-ink/60">No upcoming bookings.</p>}
          </div>
        </div>
      </section>

      <section className="px-10 pb-16">
        <div className="rounded-2xl border border-parchment bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-ink">Active bookings</h2>
            <div className="flex items-center space-x-3">
              <button
                onClick={handleCalendarSync}
                disabled={syncingCalendar}
                className="rounded-full border border-parchment px-3 py-1 text-xs font-bold uppercase tracking-widest text-ink/70 bg-white hover:bg-ink hover:text-white disabled:opacity-40"
              >
                {syncingCalendar ? 'Syncing...' : 'Sync Google'}
              </button>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="rounded-full border border-parchment px-3 py-1 text-xs text-ink/70 bg-white"
              >
                <option value="">All statuses</option>
                <option value="pending">Pending</option>
                <option value="confirmed">Confirmed</option>
                <option value="modified">Modified</option>
                <option value="cancelled">Cancelled</option>
                <option value="checked_in">Checked in</option>
                <option value="no_show">No show</option>
              </select>
              <p className="text-xs text-ink/50">Tap to confirm / cancel / check-in</p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-widest text-ink/50">
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Type</th>
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Guests</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => (
                  <tr key={b.id} className="border-t border-parchment">
                    <td className="py-2 pr-4 font-medium text-ink">{b.reservation_name || 'Guest'}</td>
                    <td className="py-2 pr-4 text-ink/70">{b.service_type}</td>
                    <td className="py-2 pr-4 text-ink/70">{formatDateValue(b.date)} {b.start_time ? `· ${b.start_time}` : ''}</td>
                    <td className="py-2 pr-4 text-ink/70">{b.people ?? '—'}</td>
                    <td className="py-2 pr-4">
                      <span className="px-3 py-1 rounded-full bg-parchment text-[11px] font-bold uppercase tracking-widest text-ink/70">
                        {b.status}
                      </span>
                    </td>
                    <td className="py-2 pr-4 space-x-2">
                      {['confirmed', 'checked_in', 'cancelled'].includes(b.status) ? null : (
                        <ActionButton
                          label="Confirm"
                          onClick={() => handleStatus(b.id, 'confirmed')}
                          loading={busyId === b.id}
                        />
                      )}
                      {b.status !== 'cancelled' && (
                        <ActionButton
                          label="Cancel"
                          onClick={() => handleStatus(b.id, 'cancelled')}
                          loading={busyId === b.id}
                        />
                      )}
                      {b.status !== 'checked_in' && b.status === 'confirmed' && (
                        <ActionButton
                          label="Check-in"
                          onClick={() => handleStatus(b.id, 'checked_in')}
                          loading={busyId === b.id}
                        />
                      )}
                    </td>
                  </tr>
                ))}
                {bookings.length === 0 && (
                  <tr>
                    <td className="py-4 text-ink/60" colSpan={6}>No bookings yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
      </>
      )}
    </main>
  );
}

function SkeletonBar({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-full bg-gradient-to-r from-parchment via-white to-parchment bg-[length:200%_100%] ${className}`} />;
}

function AdminSkeleton() {
  return (
    <>
      <section className="px-10 py-6 grid gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="rounded-2xl border border-parchment bg-white p-5 shadow-sm">
            <SkeletonBar className="h-3 w-24" />
            <SkeletonBar className="mt-5 h-8 w-16" />
            <SkeletonBar className="mt-3 h-2.5 w-32" />
          </div>
        ))}
      </section>

      <section className="px-10 pb-10 grid gap-6 md:grid-cols-3">
        <div className="rounded-2xl border border-parchment bg-white p-6 shadow-sm md:col-span-2">
          <div className="mb-6 flex items-center justify-between">
            <SkeletonBar className="h-5 w-28" />
            <SkeletonBar className="h-3 w-20" />
          </div>
          <div className="space-y-4">
            {Array.from({ length: 7 }).map((_, index) => (
              <div key={index} className="flex items-center gap-3">
                <SkeletonBar className="h-3 w-20" />
                <SkeletonBar className="h-2 flex-1" />
                <SkeletonBar className="h-3 w-8" />
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-parchment bg-white p-6 shadow-sm">
          <SkeletonBar className="mb-6 h-5 w-32" />
          <div className="space-y-4">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="border-b border-parchment pb-3 last:border-0">
                <SkeletonBar className="h-4 w-28" />
                <SkeletonBar className="mt-2 h-3 w-40" />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-10 pb-10">
        <div className="rounded-2xl border border-parchment bg-white p-6 shadow-sm">
          <div className="mb-5 flex items-center justify-between">
            <SkeletonBar className="h-5 w-44" />
            <SkeletonBar className="h-3 w-48" />
          </div>
          <div className="grid gap-3 md:grid-cols-7">
            {Array.from({ length: 7 }).map((_, index) => (
              <div key={index} className="rounded-xl border border-parchment bg-parchment/30 p-3">
                <SkeletonBar className="h-3 w-16" />
                <SkeletonBar className="mt-4 h-7 w-8" />
                <SkeletonBar className="mt-3 h-5 w-full" />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-10 pb-16">
        <div className="rounded-2xl border border-parchment bg-white p-6 shadow-sm">
          <div className="mb-6 flex items-center justify-between">
            <SkeletonBar className="h-5 w-32" />
            <div className="flex gap-3">
              <SkeletonBar className="h-8 w-36" />
              <SkeletonBar className="h-8 w-28" />
            </div>
          </div>
          <div className="space-y-4">
            {Array.from({ length: 6 }).map((_, row) => (
              <div key={row} className="grid grid-cols-6 gap-6 border-t border-parchment pt-4">
                {Array.from({ length: 6 }).map((__, col) => (
                  <SkeletonBar key={col} className={col === 0 ? 'h-4 w-28' : 'h-4 w-20'} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function StatCard({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-parchment bg-white p-5 shadow-sm">
      <p className="text-[11px] uppercase tracking-widest text-ink/50 font-bold">{label}</p>
      <p className="text-2xl font-bold text-ink mt-2">{value}</p>
      {hint && <p className="text-xs text-ink/40">{hint}</p>}
    </div>
  );
}

function ActionButton({ label, onClick, loading }: { label: string; onClick: () => void; loading?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="inline-flex items-center px-3 py-1 rounded-full border border-ink/10 text-[11px] font-bold uppercase tracking-widest text-ink/70 hover:bg-ink hover:text-white disabled:opacity-40"
    >
      {loading ? '...' : label}
    </button>
  );
}

function buildWeekView(bookings: any[]) {
  const today = new Date();
  const days: { [key: string]: any[] } = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    const key = formatDateKey(d);
    days[key] = [];
  }
  bookings.forEach((b) => {
    const key = formatDateValue(b.date);
    if (days[key]) days[key].push(b);
  });
  return Object.entries(days).map(([date, items]) => ({ date, items }));
}

function formatDateValue(value: any) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return formatDateKey(value);
  return String(value).slice(0, 10);
}

function formatDateKey(date: Date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
