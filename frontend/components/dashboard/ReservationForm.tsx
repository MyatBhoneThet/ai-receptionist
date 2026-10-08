'use client';

import React, { useMemo, useRef, useState } from 'react';
import { ApiError, Availability, AvailabilityOption, Quote, Reservation, ServiceType, newIdempotencyKey, toApiError } from '../../lib/api';
import { SERVICE_LABEL, SERVICE_UNIT, ago, money, nowTimeIn, todayIn } from '../../lib/format';
import { useDashboard } from './DashboardShell';
import { Badge, Button, ErrorNotice, Field, Notice, Select, SourceBadge, TextInput } from './ui';

export function QuoteSummary({ quote }: { quote: Quote | null | undefined }) {
    if (!quote) return null;
    return (
        <div className="rounded-xl border border-parchment bg-parchment/40 p-4 text-sm">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-ink/50">Price and terms</p>
            <dl className="space-y-1">
                {quote.lines.map((line) => (
                    <div key={line.code} className="flex justify-between gap-4"><dt className="text-ink/70">{line.label}</dt><dd className="font-medium">{money(line.amount, quote.currency)}</dd></div>
                ))}
                {Number(quote.booking_fee) > 0 && <div className="flex justify-between gap-4"><dt className="text-ink/70">Booking fee</dt><dd className="font-medium">{money(quote.booking_fee, quote.currency)}</dd></div>}
                <div className="flex justify-between gap-4 border-t border-ink/10 pt-1 font-bold"><dt>Total charged</dt><dd>{money(quote.total, quote.currency)}</dd></div>
                {Number(quote.minimum_spend) > 0 && <div className="flex justify-between gap-4 pt-1"><dt className="text-ink/70">Minimum spend <span className="text-ink/40">(commitment, not a charge)</span></dt><dd className="font-medium">{money(quote.minimum_spend, quote.currency)}</dd></div>}
                {quote.deposit.required && <div className="flex justify-between gap-4"><dt className="text-ink/70">Deposit required <span className="text-ink/40">(recorded by staff)</span></dt><dd className="font-medium">{money(quote.deposit.amount, quote.currency)}</dd></div>}
            </dl>
            {quote.policies?.check_in_time && <p className="mt-2 text-xs text-ink/60">Check-in from {quote.policies.check_in_time}, check-out by {quote.policies.check_out_time}.</p>}
            {quote.policies?.duration_minutes && !quote.policies?.check_in_time && <p className="mt-2 text-xs text-ink/60">Table held for {quote.policies.duration_minutes} minutes.</p>}
        </div>
    );
}

/**
 * Phone reservations and walk-ins. Availability is checked through the shared
 * booking layer and checked again, under lock, when the reservation is saved.
 */
export default function ReservationForm({ initialService, walkIn = false, presetResourceId, onCreated, onCancel }: {
    initialService?: ServiceType; walkIn?: boolean; presetResourceId?: number; onCreated: (reservation: Reservation) => void; onCancel: () => void;
}) {
    const { api, detail, business } = useDashboard();
    const services = detail.services.filter((service) => service.enabled);
    const [service, setService] = useState<ServiceType>(initialService || services[0]?.service_type || 'restaurant');
    const serviceInfo = detail.services.find((item) => item.service_type === service);
    const today = todayIn(business.timezone);
    const [date, setDate] = useState(today);
    const [endDate, setEndDate] = useState('');
    const [startTime, setStartTime] = useState(walkIn ? nowTimeIn(business.timezone) : '19:00');
    const [endTime, setEndTime] = useState('');
    const [people, setPeople] = useState(2);
    const [layout, setLayout] = useState('');
    const [name, setName] = useState(walkIn ? 'Walk-in' : '');
    const [phone, setPhone] = useState('');
    const [notes, setNotes] = useState('');
    const [availability, setAvailability] = useState<Availability | null>(null);
    const [chosen, setChosen] = useState<AvailabilityOption | null>(null);
    const [error, setError] = useState<ApiError | null>(null);
    const [busy, setBusy] = useState(false);
    // One key for this form instance: a double-click cannot create two reservations.
    const idempotencyKey = useRef(newIdempotencyKey('staff'));
    const external = serviceInfo?.booking_source === 'external';
    const layouts: { name: string; capacity: number }[] = serviceInfo?.effective.values.layouts || [];

    const request = useMemo(() => ({
        service_type: service, date, people,
        ...(service === 'hotel' ? { end_date: endDate } : { start_time: startTime, ...(endTime ? { end_time: endTime } : {}) }),
        ...(service === 'meeting' && layout ? { layout } : {}),
        ...(presetResourceId ? { resource_id: presetResourceId } : {}),
        ...(walkIn ? { immediate: true } : {}),
    }), [service, date, endDate, startTime, endTime, people, layout, presetResourceId, walkIn]);

    const reset = () => { setAvailability(null); setChosen(null); idempotencyKey.current = newIdempotencyKey('staff'); };

    const check = async () => {
        setBusy(true); setError(null); setChosen(null);
        try {
            const result = await api.availability(request);
            setAvailability(result);
            setChosen(result.selected);
        } catch (err) { setAvailability(null); setError(toApiError(err)); } finally { setBusy(false); }
    };

    const save = async (options: { waitlist?: boolean; hold?: boolean } = {}) => {
        setBusy(true); setError(null);
        try {
            const result = await api.createReservation({
                ...request,
                ...(chosen?.resource && !presetResourceId ? { resource_id: chosen.resource.id } : {}),
                ...(chosen && !chosen.resource && chosen.resource_type.id ? { resource_type_id: chosen.resource_type.id } : {}),
                idempotency_key: idempotencyKey.current,
                customer: { name: name.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}) },
                notes, channel: walkIn ? 'walk_in' : 'phone',
                ...(chosen?.quote ? { accepted_quote_hash: chosen.quote.hash } : {}),
                ...(options.waitlist ? { waitlist_if_unavailable: true } : {}),
                ...(options.hold ? { hold: true } : {}),
            });
            onCreated(result.reservation);
        } catch (err) {
            const apiError = toApiError(err);
            setError(apiError);
            // The option or its terms changed while the form was open: check again.
            if (apiError.code === 'conflict' || apiError.code === 'quote_changed') { idempotencyKey.current = newIdempotencyKey('staff'); await check(); }
        } finally { setBusy(false); }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <Field label="Service">
                    <Select value={service} disabled={Boolean(presetResourceId)} onChange={(event) => { setService(event.target.value as ServiceType); reset(); }}>
                        {services.map((item) => <option key={item.service_type} value={item.service_type}>{SERVICE_LABEL[item.service_type]}</option>)}
                    </Select>
                </Field>
                {serviceInfo && <SourceBadge source={serviceInfo.booking_source} name={serviceInfo.integration?.name} mock={serviceInfo.integration?.environment === 'mock'} />}
            </div>
            {external && walkIn && <Notice tone="warn">Walk-ins for this service are recorded in {serviceInfo?.integration?.name}. They appear here after synchronization.</Notice>}

            <div className="grid gap-4 md:grid-cols-3">
                <Field label={service === 'hotel' ? 'Check-in date' : 'Date'}><TextInput type="date" value={date} min={today} onChange={(event) => { setDate(event.target.value); reset(); }} /></Field>
                {service === 'hotel' ? (
                    <Field label="Check-out date"><TextInput type="date" value={endDate} min={date} onChange={(event) => { setEndDate(event.target.value); reset(); }} /></Field>
                ) : (
                    <>
                        <Field label="Start time"><TextInput type="time" value={startTime} onChange={(event) => { setStartTime(event.target.value); reset(); }} /></Field>
                        <Field label="End time" hint={service === 'restaurant' ? 'Leave empty for the default sitting length.' : undefined}>
                            <TextInput type="time" value={endTime} onChange={(event) => { setEndTime(event.target.value); reset(); }} />
                        </Field>
                    </>
                )}
                <Field label={service === 'hotel' ? 'Guests' : service === 'meeting' ? 'Attendees' : 'Party size'}>
                    <TextInput type="number" min={1} value={people} onChange={(event) => { setPeople(Number(event.target.value)); reset(); }} />
                </Field>
                {service === 'meeting' && layouts.length > 1 && (
                    <Field label="Layout">
                        <Select value={layout} onChange={(event) => { setLayout(event.target.value); reset(); }}>
                            <option value="">Any layout</option>
                            {layouts.map((item) => <option key={item.name} value={item.name}>{item.name} (up to {item.capacity})</option>)}
                        </Select>
                    </Field>
                )}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
                <Field label="Guest name"><TextInput value={name} onChange={(event) => setName(event.target.value)} /></Field>
                <Field label="Phone"><TextInput value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="Optional for walk-ins" /></Field>
                <div className="md:col-span-2"><Field label="Notes"><TextInput value={notes} onChange={(event) => setNotes(event.target.value)} /></Field></div>
            </div>

            <ErrorNotice error={error} onDismiss={() => setError(null)} />

            {availability && (
                <div className="space-y-3 rounded-xl border border-parchment p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-bold text-ink">
                            {availability.selected ? `${availability.available} option${availability.available === 1 ? '' : 's'} available` : availability.reason.message || 'Nothing is available'}
                        </p>
                        <span className="text-[11px] text-ink/50">
                            {availability.source === 'external' ? `Checked live with ${availability.provider?.name}` : 'Checked in this dashboard'} · {ago(availability.freshness.checked_at)}
                        </span>
                    </div>
                    {availability.selected && (
                        <div className="flex flex-wrap gap-2">
                            {availability.options.filter((option) => option.available).slice(0, 12).map((option, index) => {
                                const key = option.resource?.id ?? `type-${option.resource_type.id}-${index}`;
                                const active = chosen && (chosen.resource?.id ?? chosen.resource_type.id) === (option.resource?.id ?? option.resource_type.id);
                                return (
                                    <button key={key} type="button" onClick={() => setChosen(option)}
                                        className={`rounded-lg border px-3 py-2 text-left text-xs transition ${active ? 'border-ink bg-ink text-white' : 'border-parchment hover:bg-parchment'}`}>
                                        <span className="block font-bold">{option.resource ? option.resource.code : option.resource_type.name}</span>
                                        <span className="block opacity-70">{option.resource ? option.resource_type.name : 'Room assigned by the property'} · up to {option.capacity}</span>
                                        {option.ready_now === false && <span className="block text-amber-500">Not ready right now</span>}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                    {chosen && !chosen.resource && <Notice tone="info">Only the room type is confirmed. The connected system assigns the physical room later.</Notice>}
                    <QuoteSummary quote={chosen?.quote} />
                    {!availability.selected && availability.alternative && (
                        <p className="text-xs text-ink/70">Nearest alternative: {availability.alternative.date}{availability.alternative.start_time ? ` at ${availability.alternative.start_time}` : ''} ({availability.alternative.selected.resource_type.name}).</p>
                    )}
                </div>
            )}

            <div className="flex flex-wrap justify-end gap-2">
                <Button tone="ghost" onClick={onCancel}>Close</Button>
                {!availability && <Button onClick={check} busy={busy} disabled={service === 'hotel' && !endDate}>Check availability</Button>}
                {availability && !availability.selected && availability.waitlist_possible && !walkIn && (
                    <Button tone="ghost" onClick={() => save({ waitlist: true })} busy={busy} disabled={!name.trim()}>Add to waitlist</Button>
                )}
                {availability?.selected && !walkIn && !external && <Button tone="ghost" onClick={() => save({ hold: true })} busy={busy} disabled={!name.trim()}>Hold (unconfirmed)</Button>}
                {availability?.selected && (
                    <Button tone="gold" onClick={() => save()} busy={busy} disabled={!name.trim() || !chosen}>
                        {walkIn ? `Seat now${chosen?.resource ? ` at ${chosen.resource.code}` : ''}` : `Confirm ${SERVICE_UNIT[service]} reservation`}
                    </Button>
                )}
            </div>
            {availability?.selected && <Badge>Availability is checked again when you save</Badge>}
        </div>
    );
}
