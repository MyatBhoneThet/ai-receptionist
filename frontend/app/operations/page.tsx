'use client';

import React, { useEffect, useState } from 'react';
import DashboardShell, { useAsync, useDashboard } from '../../components/dashboard/DashboardShell';
import ReservationForm from '../../components/dashboard/ReservationForm';
import ReservationDetail, { statusTone } from '../../components/dashboard/ReservationDetail';
import { Badge, Button, Card, Empty, ErrorNotice, Field, Loading, Modal, Notice, Tabs, TextInput } from '../../components/dashboard/ui';
import { ApiError, BoardCard, Reservation, ServiceType, toApiError } from '../../lib/api';
import { OPERATIONAL_LABEL, SERVICE_LABEL, SERVICE_UNIT, STATUS_LABEL, ago, clock, inZone, reservationWhen, todayIn } from '../../lib/format';

const ARRIVE: Record<ServiceType, [string, string]> = { hotel: ['check_in', 'Check in'], restaurant: ['seat', 'Seat guests'], meeting: ['start', 'Start meeting'] };
const FINISH: Record<ServiceType, [string, string]> = { hotel: ['check_out', 'Check out'], restaurant: ['finish', 'Finish sitting'], meeting: ['complete', 'Complete meeting'] };
const STATE_STYLE: Record<string, string> = {
    ready: 'border-emerald-200 bg-emerald-50/60', in_use: 'border-sky-200 bg-sky-50/60',
    needs_cleaning: 'border-amber-200 bg-amber-50/60', out_of_service: 'border-rose-200 bg-rose-50/60',
};

export default function OperationsPage() {
    return (
        <DashboardShell eyebrow="Daily operations" title="Rooms, tables and today's schedule">
            <Operations />
        </DashboardShell>
    );
}

function Operations() {
    const { api, business, detail } = useDashboard();
    const today = todayIn(business.timezone);
    const enabled = detail.services.filter((service) => service.enabled);
    const [service, setService] = useState<ServiceType | 'all'>('all');
    const [date, setDate] = useState(today);
    const [view, setView] = useState<'cards' | 'schedule'>('cards');
    const board = useAsync(() => api.board(date, service === 'all' ? undefined : service), [date, service, business.id]);
    const [error, setError] = useState<ApiError | null>(null);
    const [notice, setNotice] = useState('');
    const [busyId, setBusyId] = useState<string | null>(null);
    const [form, setForm] = useState<{ walkIn: boolean; resourceId?: number; service?: ServiceType } | null>(null);
    const [selected, setSelected] = useState<Reservation | null>(null);
    const [maintenanceFor, setMaintenanceFor] = useState<BoardCard | null>(null);

    // Keep the floor view current without anyone pressing refresh.
    const { reload } = board;
    useEffect(() => {
        const timer = setInterval(() => { if (document.visibilityState === 'visible') reload(); }, 30000);
        return () => clearInterval(timer);
    }, [reload]);

    const act = async (key: string, input: Record<string, any>, done: string) => {
        setBusyId(key); setError(null); setNotice('');
        try {
            const result = await api.operate(input);
            setNotice(`${done}${result.promoted?.length ? ` ${result.promoted.length} waitlisted request(s) were given the freed place.` : ''}`);
            await board.reload();
        } catch (err) { setError(toApiError(err)); } finally { setBusyId(null); }
    };

    const data = board.data;
    return (
        <>
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex flex-wrap items-end gap-3">
                    <Field label="Day"><TextInput type="date" value={date} onChange={(event) => setDate(event.target.value || today)} /></Field>
                    <Tabs value={service} onChange={setService} options={[{ value: 'all' as const, label: 'All' }, ...enabled.map((item) => ({ value: item.service_type, label: SERVICE_LABEL[item.service_type] }))]} />
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button tone="ghost" onClick={() => setForm({ walkIn: false, service: service === 'all' ? undefined : service })}>Phone reservation</Button>
                    <Button onClick={() => setForm({ walkIn: true, service: service === 'all' ? 'restaurant' : service })}>Walk-in</Button>
                </div>
            </div>
            <p className="text-[11px] text-ink/50">Times shown in {business.timezone}. {data ? `Updated ${ago(data.generated_at)}.` : ''} Operational status is separate from reservation status.</p>

            <ErrorNotice error={error || board.error} onDismiss={() => setError(null)} />
            {notice && <Notice tone="good" onDismiss={() => setNotice('')}>{notice}</Notice>}

            {data && data.attention.length > 0 && (
                <Card title={`Needs attention (${data.attention.length})`}>
                    <ul className="space-y-2">
                        {data.attention.map((item, index) => (
                            <li key={`${item.code}-${item.booking_id}-${index}`} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
                                <span><strong className="mr-2 uppercase tracking-widest text-[10px]">{item.code.replace(/_/g, ' ')}</strong>{item.resource_code ? `${item.resource_code}: ` : ''}{item.message}</span>
                                {item.booking_id && <button className="text-[11px] font-bold uppercase tracking-widest underline"
                                    onClick={() => { const found = data.schedule.find((row) => row.id === item.booking_id) || data.cards.flatMap((card) => [card.current, card.next]).find((row) => row?.id === item.booking_id); if (found) setSelected(found); }}>Open</button>}
                            </li>
                        ))}
                    </ul>
                </Card>
            )}

            <Tabs value={view} onChange={setView} options={[{ value: 'cards', label: 'Rooms & tables', count: data?.cards.length }, { value: 'schedule', label: 'Schedule', count: data?.schedule.length }]} />

            {board.loading && !data ? <Loading /> : !data ? null : view === 'cards' ? (
                data.cards.length === 0 ? <Empty title="No rooms or tables yet">Add inventory to see it here.</Empty> : (
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                        {data.cards.map((card) => {
                            const external = card.managed_by === 'external';
                            const key = `r${card.id}`;
                            return (
                                <article key={card.id} className={`rounded-2xl border p-4 ${STATE_STYLE[card.operational_status]}`}>
                                    <div className="flex items-start justify-between gap-2">
                                        <div>
                                            <p className="text-lg font-bold text-ink">{card.code}</p>
                                            <p className="text-[11px] text-ink/60">{card.type_name}</p>
                                        </div>
                                        <Badge tone={card.operational_status === 'ready' ? 'good' : card.operational_status === 'in_use' ? 'info' : card.operational_status === 'needs_cleaning' ? 'warn' : 'bad'}>
                                            {OPERATIONAL_LABEL[card.operational_status]}
                                        </Badge>
                                    </div>
                                    {card.operational_note && <p className="mt-1 text-[11px] italic text-ink/60">{card.operational_note}</p>}
                                    {card.operational_updated_at && <p className="mt-1 text-[10px] text-ink/40">Set by {card.operational_updated_by || 'system'} · {ago(card.operational_updated_at)}</p>}

                                    {card.flags.map((flag) => <p key={flag.code + (flag.booking_id || '')} className="mt-2 rounded-lg bg-white/80 px-2 py-1 text-[11px] font-medium text-rose-700">⚠ {flag.message}</p>)}

                                    {card.current && (
                                        <button className="mt-3 block w-full rounded-xl bg-white/80 p-2 text-left text-xs" onClick={() => setSelected(card.current)}>
                                            <span className="block text-[10px] font-bold uppercase tracking-widest text-ink/40">Now</span>
                                            <span className="font-bold text-ink">{card.current.reservation_name || 'Guest'}</span> · {card.current.people} · until {card.service_type === 'hotel' ? card.current.end_date : clock(card.current.end_time)}
                                        </button>
                                    )}
                                    {card.next && (
                                        <button className="mt-2 block w-full rounded-xl bg-white/60 p-2 text-left text-xs" onClick={() => setSelected(card.next)}>
                                            <span className="block text-[10px] font-bold uppercase tracking-widest text-ink/40">Next</span>
                                            <span className="font-bold text-ink">{card.next.reservation_name || 'Guest'}</span> · {card.next.people} · {card.service_type === 'hotel' ? card.next.date : clock(card.next.start_time)}
                                        </button>
                                    )}
                                    {card.maintenance.map((block) => (
                                        <p key={block.id} className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-white/70 px-2 py-1 text-[11px] text-ink/70">
                                            <span>Maintenance {inZone(block.starts_at, business.timezone)} → {inZone(block.ends_at, business.timezone)}{block.reason ? ` · ${block.reason}` : ''}</span>
                                            <button className="font-bold underline" onClick={async () => { try { await api.removeMaintenance(block.id); await board.reload(); } catch (err) { setError(toApiError(err)); } }}>Remove</button>
                                        </p>
                                    ))}

                                    <div className="mt-3 flex flex-wrap gap-1.5">
                                        {card.current && (
                                            <Button tone="primary" busy={busyId === key} onClick={() => act(key, { action: FINISH[card.service_type][0], booking_id: card.current!.id }, `${card.code}: ${FINISH[card.service_type][1].toLowerCase()} recorded. It now needs cleaning.`)}>
                                                {FINISH[card.service_type][1]}
                                            </Button>
                                        )}
                                        {!card.current && card.next && date === today && ['confirmed', 'modified'].includes(card.next.status) && (
                                            <Button tone="primary" busy={busyId === key} onClick={() => act(key, { action: ARRIVE[card.service_type][0], booking_id: card.next!.id }, `${card.code}: ${ARRIVE[card.service_type][1].toLowerCase()} recorded.`)}>
                                                {ARRIVE[card.service_type][1]}
                                            </Button>
                                        )}
                                        {!external && !card.current && card.operational_status !== 'ready' && (
                                            <Button tone="ghost" busy={busyId === key} onClick={() => act(key, { action: 'mark_ready', resource_id: card.id }, `${card.code} is ready.`)}>Mark ready</Button>
                                        )}
                                        {!external && !card.current && card.operational_status === 'ready' && (
                                            <>
                                                {card.service_type !== 'hotel' && date === today && <Button tone="ghost" onClick={() => setForm({ walkIn: true, resourceId: card.id, service: card.service_type })}>Walk-in</Button>}
                                                <Button tone="ghost" busy={busyId === key} onClick={() => act(key, { action: 'mark_needs_cleaning', resource_id: card.id }, `${card.code} marked as needing cleaning.`)}>Needs cleaning</Button>
                                            </>
                                        )}
                                        {!external && <Button tone="ghost" onClick={() => setMaintenanceFor(card)}>Maintenance</Button>}
                                    </div>
                                    {external && <p className="mt-2 text-[10px] text-ink/50">Housekeeping status is managed in the connected system.</p>}
                                </article>
                            );
                        })}
                    </div>
                )
            ) : (
                <Card>
                    {data.schedule.length === 0 ? <Empty title="Nothing scheduled for this day" /> : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm">
                                <thead><tr className="text-[10px] font-bold uppercase tracking-widest text-ink/40">
                                    <th className="py-2 pr-4">When</th><th className="py-2 pr-4">Guest</th><th className="py-2 pr-4">Room / table</th><th className="py-2 pr-4">Status</th><th className="py-2" />
                                </tr></thead>
                                <tbody className="divide-y divide-parchment">
                                    {data.schedule.map((row) => (
                                        <tr key={row.id}>
                                            <td className="py-3 pr-4 text-ink/80">{reservationWhen(row)}</td>
                                            <td className="py-3 pr-4"><span className="font-bold text-ink">{row.reservation_name || 'Guest'}</span><span className="ml-2 text-ink/50">{row.people} · {SERVICE_UNIT[row.service_type]}</span></td>
                                            <td className="py-3 pr-4 text-ink/70">{row.resource ? row.resource.code : row.resource_type ? `${row.resource_type.name} (unassigned)` : '—'}</td>
                                            <td className="py-3 pr-4"><Badge tone={statusTone(row.display_status)}>{STATUS_LABEL[row.display_status] || row.display_status}</Badge></td>
                                            <td className="py-3 text-right"><Button tone="ghost" onClick={() => setSelected(row)}>Open</Button></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </Card>
            )}

            {form && (
                <Modal wide title={form.walkIn ? 'Seat a walk-in' : 'Add a phone reservation'} onClose={() => setForm(null)}>
                    <ReservationForm walkIn={form.walkIn} presetResourceId={form.resourceId} initialService={form.service}
                        onCancel={() => setForm(null)}
                        onCreated={async (reservation) => { setForm(null); setNotice(`Reservation #${reservation.id} saved — ${STATUS_LABEL[reservation.display_status] || reservation.display_status}.`); await board.reload(); }} />
                </Modal>
            )}
            {selected && <ReservationDetail reservation={selected} onClose={() => setSelected(null)} onChanged={() => board.reload()} />}
            {maintenanceFor && <MaintenanceModal card={maintenanceFor} onClose={() => setMaintenanceFor(null)} onSaved={async (message) => { setMaintenanceFor(null); setNotice(message); await board.reload(); }} />}
        </>
    );
}

function MaintenanceModal({ card, onClose, onSaved }: { card: BoardCard; onClose: () => void; onSaved: (message: string) => void }) {
    const { api, business } = useDashboard();
    const today = todayIn(business.timezone);
    const [from, setFrom] = useState(`${today}T09:00`);
    const [to, setTo] = useState(`${today}T17:00`);
    const [reason, setReason] = useState('');
    const [error, setError] = useState<ApiError | null>(null);
    const [busy, setBusy] = useState(false);

    // datetime-local values are wall-clock times at the venue; convert with the venue's offset.
    const toInstant = (local: string) => {
        const asUtc = new Date(`${local}:00Z`);
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: business.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
            .formatToParts(asUtc).reduce((acc: Record<string, string>, part) => ({ ...acc, [part.type]: part.value }), {});
        const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
        return new Date(asUtc.getTime() - (shown - asUtc.getTime())).toISOString();
    };

    const save = async () => {
        setBusy(true); setError(null);
        try {
            const result = await api.addMaintenance({ resource_id: card.id, starts_at: toInstant(from), ends_at: toInstant(to), reason });
            onSaved(result.conflicts.length
                ? `Maintenance added. ${result.conflicts.length} existing reservation(s) overlap it and need a decision — they were not cancelled.`
                : `Maintenance added for ${card.code}. It cannot be booked during that time.`);
        } catch (err) { setError(toApiError(err)); } finally { setBusy(false); }
    };

    return (
        <Modal title={`Maintenance — ${card.code}`} onClose={onClose}>
            <div className="space-y-4">
                <p className="text-xs text-ink/60">Blocks bookings only for this period ({business.timezone}). Other dates stay bookable.</p>
                <div className="grid gap-4 md:grid-cols-2">
                    <Field label="From"><TextInput type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} /></Field>
                    <Field label="Until"><TextInput type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} /></Field>
                </div>
                <Field label="Reason"><TextInput value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Air conditioning repair" /></Field>
                <ErrorNotice error={error} />
                <div className="flex justify-end gap-2">
                    <Button tone="ghost" onClick={onClose}>Cancel</Button>
                    <Button onClick={save} busy={busy}>Add block</Button>
                </div>
            </div>
        </Modal>
    );
}
