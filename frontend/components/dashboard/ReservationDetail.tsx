'use client';

import React, { useState } from 'react';
import { ApiError, Reservation, Resource, toApiError } from '../../lib/api';
import { SERVICE_UNIT, STATUS_LABEL, OPERATIONAL_LABEL, ago, clock, inZone, money, reservationWhen } from '../../lib/format';
import { useDashboard } from './DashboardShell';
import { QuoteSummary } from './ReservationForm';
import { Badge, Button, ErrorNotice, Field, Modal, Notice, Select, SourceBadge, TextInput } from './ui';

export function statusTone(status: string): 'good' | 'warn' | 'bad' | 'info' | 'neutral' {
    if (['confirmed', 'modified', 'completed'].includes(status)) return 'good';
    if (['checked_in'].includes(status)) return 'info';
    if (['cancelled', 'no_show'].includes(status)) return 'neutral';
    if (status === 'needs_attention') return 'bad';
    return 'warn';
}

const REVIEW: Record<string, string> = {
    missing_resource_assignment: 'Migrated without a room or table. Assign one below.',
    resource_service_mismatch: 'Migrated with a room/table from a different service. Assign the right one below.',
    double_booked: 'Overlaps another migrated reservation on the same room/table. Move or cancel one of them.',
    invalid_time_range: 'Migrated with an end time before its start. Correct the times below.',
    missing_schedule: 'Migrated without a usable date or time. Set them below.',
    legacy_pending_hold: 'An unconfirmed hold from before the upgrade. Confirm it or cancel it.',
};

export default function ReservationDetail({ reservation: initial, onClose, onChanged }: { reservation: Reservation; onClose: () => void; onChanged: () => void }) {
    const { api, business, detail } = useDashboard();
    const [reservation, setReservation] = useState(initial);
    const [error, setError] = useState<ApiError | null>(null);
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState(false);
    const service = detail.services.find((item) => item.service_type === reservation.service_type);
    const external = reservation.source === 'external';
    const active = ['pending', 'confirmed', 'modified', 'checked_in'].includes(reservation.status);
    const unit = SERVICE_UNIT[reservation.service_type];

    const run = async (work: () => Promise<{ reservation: Reservation; calendar_sync?: { status: string }; promoted?: Reservation[] }>, done: string) => {
        setBusy(true); setError(null); setNotice('');
        try {
            const result = await work();
            setReservation(result.reservation);
            const promoted = result.promoted?.length ? ` ${result.promoted.length} waitlisted request(s) were given the freed place.` : '';
            setNotice(`${done}${promoted}`);
            onChanged();
        } catch (err) { setError(toApiError(err)); } finally { setBusy(false); }
    };

    return (
        <Modal wide title={`Reservation #${reservation.id}`} onClose={onClose}>
            <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={statusTone(reservation.display_status)}>{STATUS_LABEL[reservation.display_status] || reservation.display_status}</Badge>
                    <SourceBadge source={reservation.source} name={service?.integration?.name} mock={service?.integration?.environment === 'mock'} />
                    {external && <Badge tone={reservation.sync_status === 'synced' ? 'good' : 'warn'}>Sync: {reservation.sync_status.replace(/_/g, ' ')}{reservation.sync_checked_at ? ` · ${ago(reservation.sync_checked_at)}` : ''}</Badge>}
                    {reservation.resource && <Badge>{unit} {OPERATIONAL_LABEL[reservation.resource.operational_status].toLowerCase()}</Badge>}
                </div>

                {reservation.status === 'awaiting_confirmation' && (
                    <Notice tone="warn" title="Not confirmed">The connected reservation system has not confirmed this request. Do not give the guest a confirmation.</Notice>
                )}
                {reservation.attention_reason && <Notice tone="bad" title="Staff attention required">{reservation.attention_reason}</Notice>}
                {reservation.review_reason && <Notice tone="warn" title="Needs review">{REVIEW[reservation.review_reason] || reservation.review_reason}</Notice>}
                {reservation.waitlisted && reservation.status === 'pending' && <Notice tone="info">On the waitlist. No {unit} is held for this guest.</Notice>}
                {notice && <Notice tone="good">{notice}</Notice>}
                <ErrorNotice error={error} onDismiss={() => setError(null)} />

                <dl className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-2">
                    <Row label="Guest" value={reservation.reservation_name || '—'} />
                    <Row label="Contact" value={[reservation.contact_phone, reservation.contact_email].filter(Boolean).join(' · ') || '—'} />
                    <Row label="When" value={reservationWhen(reservation)} />
                    <Row label={reservation.service_type === 'hotel' ? 'Guests' : 'Party'} value={String(reservation.people ?? '—')} />
                    <Row label={`${unit[0].toUpperCase()}${unit.slice(1)}`} value={reservation.resource ? `${reservation.resource.code} · ${reservation.resource_type?.name || ''}`
                        : reservation.resource_type ? `${reservation.resource_type.name} — ${external ? 'room not yet assigned by the property' : 'no room/table assigned'}` : 'Not assigned'} />
                    <Row label="Booked via" value={`${reservation.channel.replace(/_/g, ' ')} · ${inZone(reservation.created_at, business.timezone)}`} />
                    {reservation.external_reservation_id && <Row label="External reference" value={reservation.external_reservation_id} />}
                    {reservation.notes && <Row label="Notes" value={reservation.notes} />}
                </dl>

                <QuoteSummary quote={reservation.quote} />
                {reservation.deposit.status !== 'not_required' && (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-parchment p-4 text-sm">
                        <div>
                            <p className="font-bold text-ink">Deposit {money(reservation.deposit.amount, reservation.currency)} — {reservation.deposit.status.replace(/_/g, ' ')}</p>
                            <p className="text-xs text-ink/60">Record what happened at the desk. This dashboard does not take payments.</p>
                        </div>
                        <div className="flex gap-2">
                            {reservation.deposit.status !== 'recorded_paid' && <Button tone="ghost" busy={busy} onClick={() => run(() => api.recordDeposit(reservation.id, 'recorded_paid'), 'Deposit recorded as paid.')}>Record as paid</Button>}
                            {reservation.deposit.status === 'due' && <Button tone="ghost" busy={busy} onClick={() => run(() => api.recordDeposit(reservation.id, 'waived'), 'Deposit waived.')}>Waive</Button>}
                        </div>
                    </div>
                )}

                {editing && <EditForm reservation={reservation} onCancel={() => setEditing(false)} onSaved={(updated, message) => { setReservation(updated); setEditing(false); setNotice(message); onChanged(); }} />}

                {!editing && (
                    <div className="flex flex-wrap justify-end gap-2 border-t border-parchment pt-4">
                        {reservation.status === 'pending' && !reservation.waitlisted && !external && (
                            <Button tone="gold" busy={busy} onClick={() => run(() => api.confirmReservation(reservation.id), 'Reservation confirmed.')}>Confirm</Button>
                        )}
                        {active && <Button tone="ghost" onClick={() => setEditing(true)}>Change</Button>}
                        {(active || reservation.status === 'awaiting_confirmation') && reservation.status !== 'checked_in' && (
                            <Button tone="danger" busy={busy} onClick={() => { if (window.confirm('Cancel this reservation?')) run(() => api.cancelReservation(reservation.id, 'Cancelled by staff'), 'Reservation cancelled.'); }}>Cancel reservation</Button>
                        )}
                        <Button tone="ghost" onClick={onClose}>Close</Button>
                    </div>
                )}
            </div>
        </Modal>
    );
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex justify-between gap-4 border-b border-parchment py-1.5">
            <dt className="text-[11px] font-bold uppercase tracking-widest text-ink/40">{label}</dt>
            <dd className="text-right text-ink">{value}</dd>
        </div>
    );
}

function EditForm({ reservation, onCancel, onSaved }: { reservation: Reservation; onCancel: () => void; onSaved: (reservation: Reservation, message: string) => void }) {
    const { api } = useDashboard();
    const hotel = reservation.service_type === 'hotel';
    const external = reservation.source === 'external';
    const [date, setDate] = useState(reservation.date || '');
    const [endDate, setEndDate] = useState(reservation.end_date || '');
    const [startTime, setStartTime] = useState(clock(reservation.start_time));
    const [endTime, setEndTime] = useState(clock(reservation.end_time));
    const [people, setPeople] = useState(reservation.people || 1);
    const [name, setName] = useState(reservation.reservation_name || '');
    const [phone, setPhone] = useState(reservation.contact_phone || '');
    const [notes, setNotes] = useState(reservation.notes || '');
    const [resourceId, setResourceId] = useState<number | ''>(reservation.resource?.id || '');
    const [resources, setResources] = useState<Resource[]>([]);
    const [error, setError] = useState<ApiError | null>(null);
    const [requote, setRequote] = useState<ApiError | null>(null);
    const [busy, setBusy] = useState(false);

    React.useEffect(() => {
        if (!external) api.resources(reservation.service_type).then((list) => setResources(list.filter((item) => item.is_active))).catch(() => undefined);
    }, [api, external, reservation.service_type]);

    const changes = () => {
        const next: Record<string, any> = {};
        if (date && date !== reservation.date) next.date = date;
        if (hotel && endDate && endDate !== reservation.end_date) next.end_date = endDate;
        if (!hotel && startTime && startTime !== clock(reservation.start_time)) next.start_time = startTime;
        if (!hotel && endTime && endTime !== clock(reservation.end_time)) next.end_time = endTime;
        if (people !== reservation.people) next.people = people;
        if (name.trim() && name !== reservation.reservation_name) next.reservation_name = name.trim();
        if (phone.trim() && phone !== reservation.contact_phone) next.contact_phone = phone.trim();
        if (notes !== reservation.notes) next.notes = notes;
        if (!external && resourceId !== '' && resourceId !== reservation.resource?.id) next.resource_id = resourceId;
        return next;
    };

    const save = async (options: Record<string, any> = {}) => {
        const body = changes();
        if (!Object.keys(body).length) { onCancel(); return; }
        setBusy(true); setError(null);
        try {
            const result = await api.modifyReservation(reservation.id, body, options);
            onSaved(result.reservation, 'Reservation updated.');
        } catch (err) {
            const apiError = toApiError(err);
            if (apiError.code === 'quote_changed') setRequote(apiError); else setError(apiError);
        } finally { setBusy(false); }
    };

    return (
        <div className="space-y-4 rounded-xl border border-ink/15 p-4">
            <p className="text-[11px] font-bold uppercase tracking-widest text-ink/50">Change reservation</p>
            {external && <Notice tone="info">Date and guest changes are sent to the connected system first. If it refuses, nothing changes here.</Notice>}
            <div className="grid gap-4 md:grid-cols-3">
                <Field label={hotel ? 'Check-in' : 'Date'}><TextInput type="date" value={date} onChange={(event) => setDate(event.target.value)} /></Field>
                {hotel ? <Field label="Check-out"><TextInput type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></Field> : (
                    <>
                        <Field label="Start"><TextInput type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} /></Field>
                        <Field label="End"><TextInput type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} /></Field>
                    </>
                )}
                <Field label="Guests"><TextInput type="number" min={1} value={people} onChange={(event) => setPeople(Number(event.target.value))} /></Field>
                {!external && (
                    <Field label={`Assigned ${SERVICE_UNIT[reservation.service_type]}`}>
                        <Select value={resourceId} onChange={(event) => setResourceId(event.target.value ? Number(event.target.value) : '')}>
                            <option value="">{reservation.resource ? 'Keep current' : 'Choose automatically'}</option>
                            {resources.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.resource_type_name} · up to {item.capacity}</option>)}
                        </Select>
                    </Field>
                )}
                <Field label="Name"><TextInput value={name} onChange={(event) => setName(event.target.value)} /></Field>
                <Field label="Phone"><TextInput value={phone} onChange={(event) => setPhone(event.target.value)} /></Field>
                <div className="md:col-span-3"><Field label="Notes"><TextInput value={notes} onChange={(event) => setNotes(event.target.value)} /></Field></div>
            </div>
            <ErrorNotice error={error} onDismiss={() => setError(null)} />
            {requote && (
                <Notice tone="warn" title="The price or terms would change">
                    <p className="mb-3">Tell the guest the new terms before saving.</p>
                    <QuoteSummary quote={requote.details.quote} />
                    <div className="mt-3 flex gap-2">
                        <Button tone="gold" busy={busy} onClick={() => save({ accepted_quote_hash: requote.details.quote.hash })}>Guest accepts — save</Button>
                        <Button tone="ghost" onClick={() => setRequote(null)}>Go back</Button>
                    </div>
                </Notice>
            )}
            {!requote && (
                <div className="flex justify-end gap-2">
                    <Button tone="ghost" onClick={onCancel}>Discard</Button>
                    {!external && reservation.resource && <Button tone="ghost" busy={busy} onClick={() => save({ allow_reassign: true })}>Save, moving {SERVICE_UNIT[reservation.service_type]} if needed</Button>}
                    <Button busy={busy} onClick={() => save()}>Save changes</Button>
                </div>
            )}
        </div>
    );
}
