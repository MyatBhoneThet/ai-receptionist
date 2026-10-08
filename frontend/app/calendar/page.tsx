'use client';

import React, { useMemo, useState } from 'react';
import DashboardShell, { useAsync, useDashboard } from '../../components/dashboard/DashboardShell';
import ReservationDetail, { statusTone } from '../../components/dashboard/ReservationDetail';
import { Badge, Button, Card, Empty, ErrorNotice, Loading } from '../../components/dashboard/ui';
import { Reservation } from '../../lib/api';
import { SERVICE_UNIT, STATUS_LABEL, clock, todayIn } from '../../lib/format';

function addDays(dateKey: string, days: number) {
    const date = new Date(`${dateKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

export default function CalendarPage() {
    return (
        <DashboardShell eyebrow="Calendar" title="Reservations by day">
            <Calendar />
        </DashboardShell>
    );
}

function Calendar() {
    const { api, business } = useDashboard();
    const today = todayIn(business.timezone);
    const [start, setStart] = useState(today);
    const days = useMemo(() => Array.from({ length: 14 }, (_, index) => addDays(start, index)), [start]);
    const [selected, setSelected] = useState<Reservation | null>(null);
    // A day either side so stays that began earlier are still included.
    const list = useAsync(() => api.reservations({ from: new Date(`${addDays(start, -1)}T00:00:00Z`).toISOString(), to: new Date(`${addDays(start, 16)}T00:00:00Z`).toISOString(), order: 'schedule', limit: 500 }), [start, business.id]);

    const onDay = (day: string) => (list.data || []).filter((row) => {
        if (!row.date || ['cancelled', 'no_show'].includes(row.status)) return false;
        return row.service_type === 'hotel' ? row.date <= day && (row.end_date || row.date) > day : row.date === day;
    });

    return (
        <>
            <div className="flex flex-wrap items-center gap-2">
                <Button tone="ghost" onClick={() => setStart(addDays(start, -14))}>← Earlier</Button>
                <Button tone="ghost" onClick={() => setStart(today)}>Today</Button>
                <Button tone="ghost" onClick={() => setStart(addDays(start, 14))}>Later →</Button>
                <span className="text-xs text-ink/50">Dates in {business.timezone}. Hotel stays appear on each night.</span>
            </div>
            <ErrorNotice error={list.error} />
            {list.loading && !list.data ? <Loading /> : (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    {days.map((day) => {
                        const rows = onDay(day);
                        return (
                            <Card key={day} className="!p-4">
                                <div className="flex items-baseline justify-between">
                                    <p className={`text-[11px] font-bold uppercase tracking-widest ${day === today ? 'text-gold' : 'text-ink/50'}`}>
                                        {new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))}{day === today ? ' · today' : ''}
                                    </p>
                                    <p className="text-xl font-bold text-ink">{rows.length}</p>
                                </div>
                                <div className="mt-3 max-h-64 space-y-2 overflow-auto">
                                    {rows.map((row) => (
                                        <button key={row.id} onClick={() => setSelected(row)} className="block w-full rounded-xl border border-parchment px-3 py-2 text-left hover:bg-parchment/50">
                                            <p className="text-sm font-bold text-ink">{row.reservation_name || 'Guest'}</p>
                                            <p className="text-xs text-ink/60">{SERVICE_UNIT[row.service_type]} {row.resource?.code || row.resource_type?.name || ''} · {row.service_type === 'hotel' ? `until ${row.end_date}` : clock(row.start_time)}</p>
                                            <Badge tone={statusTone(row.display_status)}>{STATUS_LABEL[row.display_status] || row.display_status}</Badge>
                                        </button>
                                    ))}
                                    {rows.length === 0 && <p className="text-xs text-ink/40">Nothing booked.</p>}
                                </div>
                            </Card>
                        );
                    })}
                </div>
            )}
            {!list.loading && (list.data || []).length === 0 && <Empty title="No reservations in this period" />}
            {selected && <ReservationDetail reservation={selected} onClose={() => setSelected(null)} onChanged={() => list.reload()} />}
        </>
    );
}
