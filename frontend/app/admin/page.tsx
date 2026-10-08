'use client';

import React, { useState } from 'react';
import DashboardShell, { useAsync, useDashboard } from '../../components/dashboard/DashboardShell';
import ReservationForm from '../../components/dashboard/ReservationForm';
import ReservationDetail, { statusTone } from '../../components/dashboard/ReservationDetail';
import { Badge, Button, Card, Empty, ErrorNotice, Loading, Modal, Notice, Select, SourceBadge, Tabs, TextInput } from '../../components/dashboard/ui';
import { Reservation, ServiceType } from '../../lib/api';
import { SERVICE_LABEL, STATUS_LABEL, money, reservationWhen } from '../../lib/format';

type Filter = 'upcoming' | 'needs_attention' | 'waitlisted' | 'pending' | 'cancelled' | 'all';

export default function ReservationsPage() {
    return (
        <DashboardShell eyebrow="Reservations" title="All reservations">
            <Reservations />
        </DashboardShell>
    );
}

function Reservations() {
    const { api, business, detail } = useDashboard();
    const [filter, setFilter] = useState<Filter>('upcoming');
    const [service, setService] = useState<ServiceType | ''>('');
    const [search, setSearch] = useState('');
    const [submitted, setSubmitted] = useState('');
    const [selected, setSelected] = useState<Reservation | null>(null);
    const [creating, setCreating] = useState(false);
    const [notice, setNotice] = useState('');

    const list = useAsync(() => api.reservations({
        ...(service ? { service_type: service } : {}),
        ...(submitted ? { search: submitted } : {}),
        ...(filter === 'upcoming' ? { from: new Date().toISOString(), order: 'schedule' } : {}),
        ...(['needs_attention', 'waitlisted', 'pending', 'cancelled'].includes(filter) ? { status: filter } : {}),
        limit: 200,
    }), [filter, service, submitted, business.id]);

    const rows = (list.data || []).filter((row) => filter !== 'upcoming' || !['cancelled', 'no_show', 'completed'].includes(row.status));
    const sourceOf = (row: Reservation) => detail.services.find((item) => item.service_type === row.service_type);

    return (
        <>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <Tabs value={filter} onChange={setFilter} options={[
                    { value: 'upcoming', label: 'Upcoming' }, { value: 'needs_attention', label: 'Needs attention' }, { value: 'waitlisted', label: 'Waitlist' },
                    { value: 'pending', label: 'Held' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'all', label: 'All' }]} />
                <Button onClick={() => setCreating(true)}>New reservation</Button>
            </div>
            <form className="flex flex-wrap gap-3" onSubmit={(event) => { event.preventDefault(); setSubmitted(search.trim()); }}>
                <Select className="max-w-[14rem]" value={service} onChange={(event) => setService(event.target.value as ServiceType | '')} aria-label="Service">
                    <option value="">All services</option>
                    {detail.services.filter((item) => item.enabled).map((item) => <option key={item.service_type} value={item.service_type}>{SERVICE_LABEL[item.service_type]}</option>)}
                </Select>
                <TextInput className="max-w-xs" placeholder="Search name or phone" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search reservations" />
                <Button tone="ghost" type="submit">Search</Button>
            </form>

            {notice && <Notice tone="good" onDismiss={() => setNotice('')}>{notice}</Notice>}
            <ErrorNotice error={list.error} />

            <Card>
                {list.loading && !list.data ? <Loading /> : rows.length === 0 ? (
                    <Empty title={filter === 'needs_attention' ? 'Nothing needs attention' : 'No reservations match'}>
                        {filter === 'upcoming' ? 'New reservations from chat, phone and walk-ins appear here.' : 'Try another filter.'}
                    </Empty>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead><tr className="text-[10px] font-bold uppercase tracking-widest text-ink/40">
                                <th className="py-2 pr-4">#</th><th className="py-2 pr-4">Guest</th><th className="py-2 pr-4">When</th><th className="py-2 pr-4">Room / table</th>
                                <th className="py-2 pr-4">Status</th><th className="py-2 pr-4">Total</th><th className="py-2 pr-4">Source</th><th className="py-2" />
                            </tr></thead>
                            <tbody className="divide-y divide-parchment">
                                {rows.map((row) => {
                                    const info = sourceOf(row);
                                    return (
                                        <tr key={row.id} className="align-top">
                                            <td className="py-3 pr-4 font-mono text-xs text-ink/50">{row.id}</td>
                                            <td className="py-3 pr-4"><p className="font-bold text-ink">{row.reservation_name || 'Guest'}</p><p className="text-xs text-ink/50">{row.contact_phone || '—'} · {row.people ?? '?'} guests</p></td>
                                            <td className="py-3 pr-4 text-ink/80">{reservationWhen(row)}<p className="text-xs text-ink/40">{SERVICE_LABEL[row.service_type]}</p></td>
                                            <td className="py-3 pr-4 text-ink/70">{row.resource ? row.resource.code : row.resource_type ? `${row.resource_type.name} · unassigned` : '—'}</td>
                                            <td className="py-3 pr-4">
                                                <Badge tone={statusTone(row.display_status)}>{STATUS_LABEL[row.display_status] || row.display_status}</Badge>
                                                {row.review_reason && <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-amber-700">Review: {row.review_reason.replace(/_/g, ' ')}</p>}
                                                {row.deposit.status === 'due' && <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-amber-700">Deposit due</p>}
                                            </td>
                                            <td className="py-3 pr-4 text-ink/70">{money(row.total_amount, row.currency)}</td>
                                            <td className="py-3 pr-4"><SourceBadge source={row.source} name={info?.integration?.name} mock={info?.integration?.environment === 'mock'} /></td>
                                            <td className="py-3 text-right"><Button tone="ghost" onClick={() => setSelected(row)}>Open</Button></td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>

            {creating && (
                <Modal wide title="New reservation" onClose={() => setCreating(false)}>
                    <ReservationForm onCancel={() => setCreating(false)}
                        onCreated={async (reservation) => { setCreating(false); setNotice(`Reservation #${reservation.id} saved — ${STATUS_LABEL[reservation.display_status] || reservation.display_status}.`); await list.reload(); }} />
                </Modal>
            )}
            {selected && <ReservationDetail reservation={selected} onClose={() => setSelected(null)} onChanged={() => list.reload()} />}
        </>
    );
}
