'use client';

import React from 'react';
import DashboardShell, { useAsync, useDashboard } from '../../components/dashboard/DashboardShell';
import { statusTone } from '../../components/dashboard/ReservationDetail';
import { Badge, Card, Empty, ErrorNotice, Loading, SourceBadge } from '../../components/dashboard/ui';
import { SERVICE_LABEL, STATUS_LABEL, ago, reservationWhen } from '../../lib/format';

export default function DashboardPage() {
    return (
        <DashboardShell eyebrow="Overview" title="Business at a glance">
            <Overview />
        </DashboardShell>
    );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
    return (
        <div className="rounded-2xl border border-parchment bg-white p-5 shadow-sm">
            <p className="text-[11px] font-bold uppercase tracking-widest text-ink/50">{label}</p>
            <p className="mt-2 text-3xl font-bold text-ink">{value}</p>
            {hint && <p className="mt-1 text-xs text-ink/50">{hint}</p>}
        </div>
    );
}

function Overview() {
    const { api, detail, business } = useDashboard();
    const summary = useAsync(() => api.analyticsSummary(), [business.id]);
    const series = useAsync(() => api.analyticsTimeseries(), [business.id]);
    const recent = useAsync(() => api.recent(), [business.id]);
    const peak = Math.max(1, ...(series.data || []).map((row) => row.bookings));

    return (
        <>
            <ErrorNotice error={summary.error || series.error || recent.error} />
            {summary.loading && !summary.data ? <Loading /> : summary.data && (
                <div className="grid gap-4 md:grid-cols-4">
                    <Stat label="Active reservations" value={summary.data.total_bookings} />
                    <Stat label="Today" value={summary.data.today_bookings} hint={`Business day in ${business.timezone}`} />
                    <Stat label="Waitlist" value={summary.data.waitlisted} hint="No place held" />
                    <Stat label="Cancelled" value={summary.data.cancellations} />
                </div>
            )}

            <Card title="Services and booking source" hint="Each service has exactly one authoritative booking record.">
                <div className="grid gap-3 md:grid-cols-3">
                    {detail.services.map((service) => {
                        const review = detail.activation.services.find((item) => item.service_type === service.service_type);
                        return (
                            <div key={service.service_type} className={`rounded-xl border p-4 ${service.enabled ? 'border-parchment' : 'border-dashed border-ink/10 opacity-60'}`}>
                                <div className="flex items-center justify-between gap-2">
                                    <p className="font-bold text-ink">{SERVICE_LABEL[service.service_type]}</p>
                                    {!service.enabled ? <Badge>Off</Badge> : review?.ready ? <Badge tone="good">Bookable</Badge> : <Badge tone="warn">Not bookable</Badge>}
                                </div>
                                {service.enabled && (
                                    <>
                                        <div className="mt-2"><SourceBadge source={service.booking_source} name={service.integration?.name} mock={service.integration?.environment === 'mock'} /></div>
                                        <p className="mt-2 text-xs text-ink/60">
                                            {service.booking_source === 'external'
                                                ? `Availability is asked of the connected system on every check. Last reconciled ${ago(service.integration?.last_reconciled_at)}.`
                                                : 'Availability is computed live from this dashboard\'s reservations.'}
                                        </p>
                                        <p className="mt-2 text-xs text-ink/60">{summary.data?.by_service[service.service_type] ?? 0} active reservation(s)</p>
                                        {review && !review.ready && <ul className="mt-2 list-disc pl-4 text-xs text-amber-800">{review.blockers.map((blocker) => <li key={blocker.code}>{blocker.message}</li>)}</ul>}
                                    </>
                                )}
                            </div>
                        );
                    })}
                </div>
            </Card>

            <div className="grid gap-6 md:grid-cols-3">
                <Card title="Reservations by date" hint="Last 7 and next 7 days" className="md:col-span-2">
                    {series.loading && !series.data ? <Loading /> : !series.data?.length ? <Empty title="No reservations in this window" /> : (
                        <div className="space-y-2">
                            {series.data.map((row) => (
                                <div key={row.date} className="flex items-center gap-3">
                                    <span className="w-24 font-mono text-xs text-ink/60">{row.date}</span>
                                    <div className="relative h-2 flex-1 rounded-full bg-parchment"><div className="absolute inset-y-0 left-0 rounded-full bg-ink" style={{ width: `${(row.bookings / peak) * 100}%` }} /></div>
                                    <span className="w-8 text-right text-xs font-bold text-ink">{row.bookings}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </Card>
                <Card title="Most recent">
                    {recent.loading && !recent.data ? <Loading /> : !recent.data?.length ? <Empty title="No reservations yet">They appear here as guests book.</Empty> : (
                        <div className="space-y-3">
                            {recent.data.map((row) => (
                                <div key={row.id} className="rounded-xl border border-parchment px-3 py-2">
                                    <div className="flex items-center justify-between gap-2">
                                        <p className="text-sm font-bold text-ink">{row.reservation_name || 'Guest'}</p>
                                        <Badge tone={statusTone(row.display_status)}>{STATUS_LABEL[row.display_status] || row.display_status}</Badge>
                                    </div>
                                    <p className="text-xs text-ink/60">{SERVICE_LABEL[row.service_type]} · {reservationWhen(row)}</p>
                                </div>
                            ))}
                        </div>
                    )}
                </Card>
            </div>
        </>
    );
}
