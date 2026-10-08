'use client';

import React, { useState } from 'react';
import DashboardShell, { useOptionalDashboard } from '../../components/dashboard/DashboardShell';
import { Badge, Button, Card, ErrorNotice, Field, Notice, Select, SourceBadge, TextInput } from '../../components/dashboard/ui';
import { ApiError, BookingSource, ServiceType, createBusiness, toApiError } from '../../lib/api';
import { SERVICES, SERVICE_LABEL, STATUS_LABEL } from '../../lib/format';

export default function SetupPage() {
    return (
        <DashboardShell eyebrow="Setup" title="Set up your business" managerOnly>
            <Setup />
        </DashboardShell>
    );
}

function Setup() {
    const dashboard = useOptionalDashboard();
    return dashboard ? <Checklist /> : <CreateBusiness />;
}

const slugify = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/** Steps 1–4: the business, its services, its locale, and each service's booking source. */
function CreateBusiness() {
    const [step, setStep] = useState(1);
    const [name, setName] = useState('');
    const [slug, setSlug] = useState('');
    const [slugTouched, setSlugTouched] = useState(false);
    const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    const [currency, setCurrency] = useState('');
    const [email, setEmail] = useState('');
    const [phone, setPhone] = useState('');
    const [address, setAddress] = useState('');
    const [services, setServices] = useState<Record<ServiceType, { enabled: boolean; booking_source: BookingSource }>>({
        hotel: { enabled: false, booking_source: 'internal' }, restaurant: { enabled: true, booking_source: 'internal' }, meeting: { enabled: false, booking_source: 'internal' },
    });
    const [error, setError] = useState<ApiError | null>(null);
    const [busy, setBusy] = useState(false);
    const chosen = SERVICES.filter((service) => services[service].enabled);
    const timezones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [timezone];

    const submit = async () => {
        setBusy(true); setError(null);
        try {
            const created = await createBusiness({ name: name.trim(), slug, timezone, currency: currency.toUpperCase(), contact_email: email.trim(), contact_phone: phone.trim(), address: address.trim(),
                services: SERVICES.map((service) => ({ service_type: service, ...services[service] })) });
            localStorage.setItem('ai_receptionist_business_id', String(created.id));
            window.location.href = '/setup';
        } catch (err) { setError(toApiError(err)); } finally { setBusy(false); }
    };

    return (
        <Card title={`Step ${step} of 4`} hint="You can change everything except the booking identifier later.">
            <ol className="mb-6 flex flex-wrap gap-2 text-[11px] font-bold uppercase tracking-widest">
                {['Business', 'Services', 'Locale & contact', 'Booking source'].map((label, index) => (
                    <li key={label} className={`rounded-full px-3 py-1 ${step === index + 1 ? 'bg-ink text-white' : step > index + 1 ? 'bg-emerald-50 text-emerald-700' : 'bg-parchment text-ink/40'}`}>{index + 1}. {label}</li>
                ))}
            </ol>

            {step === 1 && (
                <div className="grid gap-4 md:grid-cols-2">
                    <Field label="Business name"><TextInput value={name} autoFocus onChange={(event) => { setName(event.target.value); if (!slugTouched) setSlug(slugify(event.target.value)); }} placeholder="e.g. Lumière Grand Hotel" /></Field>
                    <Field label="Public booking identifier" hint={`Guests will book at /?business=${slug || 'your-business'}. Lowercase letters, digits and hyphens.`}>
                        <TextInput value={slug} onChange={(event) => { setSlugTouched(true); setSlug(slugify(event.target.value)); }} />
                    </Field>
                    <p className="text-xs text-ink/60 md:col-span-2">One business is one physical venue. Its rooms, tables, reservations, customers and settings are kept separate from every other business.</p>
                </div>
            )}

            {step === 2 && (
                <div className="grid gap-3 md:grid-cols-3">
                    {SERVICES.map((service) => (
                        <label key={service} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${services[service].enabled ? 'border-ink bg-white' : 'border-parchment bg-parchment/40'}`}>
                            <input type="checkbox" className="mt-1" checked={services[service].enabled} onChange={(event) => setServices({ ...services, [service]: { ...services[service], enabled: event.target.checked } })} />
                            <span>
                                <span className="block font-bold text-ink">{SERVICE_LABEL[service]}</span>
                                <span className="block text-xs text-ink/60">{service === 'hotel' ? 'Stays by the night.' : service === 'restaurant' ? 'Table reservations and walk-ins.' : 'Rooms booked by the hour or day.'}</span>
                            </span>
                        </label>
                    ))}
                </div>
            )}

            {step === 3 && (
                <div className="grid gap-4 md:grid-cols-2">
                    <Field label="Timezone" hint="All dates and opening hours are in this timezone.">
                        <Select value={timezone} onChange={(event) => setTimezone(event.target.value)}>{timezones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}</Select>
                    </Field>
                    <Field label="Currency" hint="Three-letter code, e.g. THB, USD, EUR. Used for every price."><TextInput value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value.toUpperCase())} placeholder="THB" /></Field>
                    <Field label="Contact email"><TextInput type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
                    <Field label="Contact phone"><TextInput value={phone} onChange={(event) => setPhone(event.target.value)} /></Field>
                    <div className="md:col-span-2"><Field label="Address"><TextInput value={address} onChange={(event) => setAddress(event.target.value)} /></Field></div>
                </div>
            )}

            {step === 4 && (
                <div className="space-y-3">
                    <p className="text-xs text-ink/60">Each service has exactly one authoritative booking record. Choose now — it cannot simply be toggled later once reservations exist.</p>
                    {chosen.map((service) => (
                        <div key={service} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-parchment p-4">
                            <span className="font-bold text-ink">{SERVICE_LABEL[service]}</span>
                            <Select className="max-w-md" value={services[service].booking_source} onChange={(event) => setServices({ ...services, [service]: { ...services[service], booking_source: event.target.value as BookingSource } })}>
                                <option value="internal">Managed in this dashboard — our database is the booking record</option>
                                <option value="external">External PMS / reservation system is the booking record</option>
                            </Select>
                        </div>
                    ))}
                    {chosen.some((service) => services[service].booking_source === 'external') && (
                        <Notice tone="warn">No production connector exists yet. An externally sourced service can be rehearsed with the mock connection, but guests cannot book it until a real connector is implemented and validated.</Notice>
                    )}
                </div>
            )}

            <div className="mt-6 space-y-3">
                <ErrorNotice error={error} onDismiss={() => setError(null)} />
                <div className="flex justify-between">
                    <Button tone="ghost" disabled={step === 1} onClick={() => setStep(step - 1)}>Back</Button>
                    {step < 4 ? (
                        <Button onClick={() => setStep(step + 1)} disabled={(step === 1 && (!name.trim() || slug.length < 3)) || (step === 2 && !chosen.length) || (step === 3 && currency.length !== 3)}>Continue</Button>
                    ) : <Button tone="gold" busy={busy} onClick={submit}>Create business</Button>}
                </div>
            </div>
        </Card>
    );
}

/** Steps 5–6: inventory (or mapping), then review and activate. */
function Checklist() {
    const dashboard = useOptionalDashboard()!;
    const { api, detail, business, reload } = dashboard;
    const [error, setError] = useState<ApiError | null>(null);
    const [busy, setBusy] = useState(false);
    const review = detail.activation;
    const legacy = business.is_legacy;
    const [legacyItems, setLegacyItems] = useState<any[] | null>(null);
    React.useEffect(() => { if (legacy) api.review().then((report) => setLegacyItems(report.items)).catch(() => setLegacyItems([])); }, [api, legacy]);

    const setStatus = async (status: 'active' | 'paused') => {
        setBusy(true); setError(null);
        try { await api.setStatus(status); await reload(); } catch (err) { setError(toApiError(err)); } finally { setBusy(false); }
    };

    return (
        <>
            <Card title="1–4 · Business, services, locale and booking source"
                action={<a href="/settings" className="text-[11px] font-bold uppercase tracking-widest text-ink/50 underline">Edit in settings</a>}>
                <dl className="grid gap-2 text-sm md:grid-cols-2">
                    <div><dt className="text-[11px] font-bold uppercase tracking-widest text-ink/40">Business</dt><dd>{business.name} · /?business={business.slug}</dd></div>
                    <div><dt className="text-[11px] font-bold uppercase tracking-widest text-ink/40">Timezone & currency</dt><dd>{business.timezone} · {business.currency_confirmed ? business.currency : <span className="font-bold text-amber-700">currency not confirmed</span>}</dd></div>
                </dl>
                {review.business_blockers.length > 0 && <ul className="mt-3 list-disc pl-5 text-sm text-amber-800">{review.business_blockers.map((blocker) => <li key={blocker.code}>{blocker.message}</li>)}</ul>}
            </Card>

            <Card title="5 · Inventory" hint="Configure rooms and tables here, or connect and map an external system.">
                <div className="grid gap-3 md:grid-cols-3">
                    {detail.services.filter((service) => service.enabled).map((service) => {
                        const state = review.services.find((item) => item.service_type === service.service_type);
                        return (
                            <div key={service.service_type} className="rounded-xl border border-parchment p-4">
                                <div className="flex items-center justify-between gap-2">
                                    <p className="font-bold text-ink">{SERVICE_LABEL[service.service_type]}</p>
                                    {state?.ready ? <Badge tone="good">Ready</Badge> : <Badge tone="warn">To do</Badge>}
                                </div>
                                <div className="mt-2"><SourceBadge source={service.booking_source} name={service.integration?.name} mock={service.integration?.environment === 'mock'} /></div>
                                {state && !state.ready && (
                                    <ul className="mt-3 space-y-2 text-xs text-amber-800">
                                        {state.blockers.map((blocker) => (
                                            <li key={blocker.code}>
                                                {blocker.message}
                                                {blocker.bookings && <span className="block text-ink/60">Reservations: {blocker.bookings.map((item) => `#${item.id}`).join(', ')} — open them under Reservations → Needs attention.</span>}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                <a href={service.booking_source === 'internal' ? '/inventory' : '/integrations'} className="mt-3 inline-block text-[11px] font-bold uppercase tracking-widest text-ink underline">
                                    {service.booking_source === 'internal' ? 'Manage inventory' : 'Connect & map'}
                                </a>
                            </div>
                        );
                    })}
                    {!detail.services.some((service) => service.enabled) && <p className="text-sm text-ink/60">No services enabled. Turn one on in Settings → Services.</p>}
                </div>
            </Card>

            {legacy && (
                <Card title="Migrated reservations to review" hint="These came from before the upgrade and could not be migrated without a decision. Nothing was guessed.">
                    {legacyItems === null ? <p className="text-sm text-ink/60">Loading…</p> : legacyItems.length === 0 ? <p className="text-sm text-ink/60">Nothing needs review.</p> : (
                        <table className="w-full text-left text-sm">
                            <thead><tr className="text-[10px] font-bold uppercase tracking-widest text-ink/40"><th className="py-2 pr-4">#</th><th className="py-2 pr-4">Guest</th><th className="py-2 pr-4">Service</th><th className="py-2 pr-4">Issue</th><th className="py-2">Blocks activation</th></tr></thead>
                            <tbody className="divide-y divide-parchment">
                                {legacyItems.map((item) => (
                                    <tr key={item.id}>
                                        <td className="py-2 pr-4 font-mono text-xs">{item.id}</td><td className="py-2 pr-4">{item.reservation_name || '—'}</td><td className="py-2 pr-4">{item.service_type}</td>
                                        <td className="py-2 pr-4">{String(item.review_reason).replace(/_/g, ' ')} <span className="text-ink/40">({STATUS_LABEL[item.status] || item.status})</span></td>
                                        <td className="py-2">{item.blocking ? <Badge tone="warn">Yes</Badge> : <Badge>No</Badge>}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </Card>
            )}

            <Card title="6 · Review and activate customer booking">
                <div className="space-y-3">
                    <p className="text-sm text-ink/70">
                        {business.status === 'active'
                            ? `Guests can currently book: ${review.bookable_services.map((service) => SERVICE_LABEL[service]).join(', ') || 'nothing — every enabled service has an open item above'}.`
                            : review.can_activate ? `Ready. Activating lets guests book: ${review.bookable_services.map((service) => SERVICE_LABEL[service]).join(', ')}.` : 'Finish the open items above first.'}
                    </p>
                    <ErrorNotice error={error} onDismiss={() => setError(null)} />
                    <div className="flex flex-wrap gap-2">
                        {business.status !== 'active' && <Button tone="gold" busy={busy} disabled={!review.can_activate} onClick={() => setStatus('active')}>Activate customer booking</Button>}
                        {business.status === 'active' && <Button tone="danger" busy={busy} onClick={() => setStatus('paused')}>Pause customer booking</Button>}
                        <a href={`/?business=${business.slug}`} className="rounded-full border border-ink/15 px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-ink/70">Open guest chat</a>
                    </div>
                </div>
            </Card>
        </>
    );
}
