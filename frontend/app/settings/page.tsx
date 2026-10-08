'use client';

import React, { useEffect, useState } from 'react';
import DashboardShell, { useAsync, useDashboard } from '../../components/dashboard/DashboardShell';
import ConfigFields from '../../components/dashboard/ConfigFields';
import { Badge, Button, Card, Empty, ErrorNotice, Field, Loading, Notice, Select, SourceBadge, Tabs, TextInput } from '../../components/dashboard/ui';
import { ApiError, BusinessService, NotificationSettings, Role, ServiceType, toApiError } from '../../lib/api';
import { SERVICE_LABEL, inZone } from '../../lib/format';

type Tab = 'business' | 'services' | 'closures' | 'team' | 'notifications' | 'audit';

export default function SettingsPage() {
    return (
        <DashboardShell eyebrow="Settings" title="Business and service settings" managerOnly>
            <Settings />
        </DashboardShell>
    );
}

function Settings() {
    const [tab, setTab] = useState<Tab>('business');
    return (
        <>
            <Tabs value={tab} onChange={setTab} options={[
                { value: 'business', label: 'Business' }, { value: 'services', label: 'Services & rules' }, { value: 'closures', label: 'Closure dates' },
                { value: 'team', label: 'Team access' }, { value: 'notifications', label: 'Notifications & calendar' }, { value: 'audit', label: 'Audit history' }]} />
            {tab === 'business' && <BusinessTab />}
            {tab === 'services' && <ServicesTab />}
            {tab === 'closures' && <ClosuresTab />}
            {tab === 'team' && <TeamTab />}
            {tab === 'notifications' && <NotificationsTab />}
            {tab === 'audit' && <AuditTab />}
        </>
    );
}

function useSave() {
    const [error, setError] = useState<ApiError | null>(null);
    const [saved, setSaved] = useState('');
    const [busy, setBusy] = useState(false);
    const run = async (work: () => Promise<unknown>, message = 'Saved.') => {
        setBusy(true); setError(null); setSaved('');
        try { await work(); setSaved(message); return true; } catch (err) { setError(toApiError(err)); return false; } finally { setBusy(false); }
    };
    return { error, saved, busy, run, setError, setSaved };
}

function BusinessTab() {
    const { api, business, reload } = useDashboard();
    const [form, setForm] = useState({ name: business.name, timezone: business.timezone, currency: business.currency || '', contact_email: business.contact_email, contact_phone: business.contact_phone, address: business.address });
    const save = useSave();
    const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => setForm((current) => ({ ...current, [key]: event.target.value }));
    return (
        <Card title="Business profile" hint="One business is one physical venue.">
            <div className="grid gap-4 md:grid-cols-2">
                <Field label="Business name"><TextInput value={form.name} onChange={set('name')} /></Field>
                <Field label="Public booking identifier" hint={`Guests book at /?business=${business.slug}`}><TextInput value={business.slug} disabled /></Field>
                <Field label="Timezone" hint="IANA name, e.g. Asia/Bangkok. Fixed once reservations exist."><TextInput value={form.timezone} onChange={set('timezone')} /></Field>
                <Field label="Currency" hint={business.currency_confirmed ? 'Fixed once reservations have been priced.' : 'Not confirmed yet — required before guests can book.'}>
                    <TextInput value={form.currency} onChange={(event) => setForm((current) => ({ ...current, currency: event.target.value.toUpperCase() }))} placeholder="THB" maxLength={3} />
                </Field>
                <Field label="Contact email"><TextInput type="email" value={form.contact_email} onChange={set('contact_email')} /></Field>
                <Field label="Contact phone"><TextInput value={form.contact_phone} onChange={set('contact_phone')} /></Field>
                <div className="md:col-span-2"><Field label="Address"><TextInput value={form.address} onChange={set('address')} /></Field></div>
            </div>
            <div className="mt-4 space-y-3">
                {!business.currency_confirmed && <Notice tone="warn">Confirm the currency used for all prices. Existing prices from before the upgrade were stored without one.</Notice>}
                <ErrorNotice error={save.error} />
                {save.saved && <Notice tone="good">{save.saved}</Notice>}
                <Button busy={save.busy} onClick={async () => {
                    const body: Record<string, any> = { ...form };
                    if (!body.currency) delete body.currency;
                    if (await save.run(() => api.update(body))) await reload();
                }}>Save profile</Button>
            </div>
        </Card>
    );
}

function ServicesTab() {
    const { detail } = useDashboard();
    return (
        <div className="space-y-6">
            {detail.services.map((service) => <ServiceCard key={service.service_type} service={service} />)}
        </div>
    );
}

function ServiceCard({ service }: { service: BusinessService }) {
    const { api, business, reload } = useDashboard();
    const [settings, setSettings] = useState<Record<string, any>>(service.settings);
    const [integrations, setIntegrations] = useState<{ id: number; name: string; is_mock: boolean }[]>([]);
    const save = useSave();
    const external = service.booking_source === 'external';
    useEffect(() => { api.integrations().then((data) => setIntegrations(data.integrations)).catch(() => undefined); }, [api]);
    const apply = async (body: Record<string, any>, message?: string) => { if (await save.run(() => api.updateService(service.service_type, body), message)) await reload(); };

    return (
        <Card title={SERVICE_LABEL[service.service_type]}
            action={<div className="flex items-center gap-2">
                <SourceBadge source={service.booking_source} name={service.integration?.name} mock={service.integration?.environment === 'mock'} />
                <Button tone={service.enabled ? 'ghost' : 'primary'} busy={save.busy} onClick={() => apply({ enabled: !service.enabled }, service.enabled ? 'Service turned off.' : 'Service enabled.')}>
                    {service.enabled ? 'Turn off' : 'Enable'}
                </Button>
            </div>}>
            <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                    <Field label="Authoritative booking source" hint="Exactly one per service. It cannot be switched while active or upcoming reservations exist; that needs a controlled migration.">
                        <Select value={service.booking_source} onChange={(event) => apply({ booking_source: event.target.value }, 'Booking source changed.')}>
                            <option value="internal">This dashboard</option>
                            <option value="external">External reservation system</option>
                        </Select>
                    </Field>
                    {external && (
                        <Field label="Connected system" hint={<>Set up connections in <a className="underline" href="/integrations">Integrations</a>.</>}>
                            <Select value={service.integration_id ?? ''} onChange={(event) => apply({ integration_id: event.target.value ? Number(event.target.value) : null }, 'Connection updated.')}>
                                <option value="">Not connected</option>
                                {integrations.map((item) => <option key={item.id} value={item.id}>{item.name}{item.is_mock ? ' (MOCK)' : ''}</option>)}
                            </Select>
                        </Field>
                    )}
                </div>
                {external ? (
                    <Notice tone="info">Prices, capacities, availability and booking rules come from the connected system. The times below are only used to turn dates into local check-in and check-out moments.</Notice>
                ) : (
                    <p className="text-xs text-ink/60">These are the service defaults. Every type inherits them and can override any value; individual rooms or tables can override again.</p>
                )}
                <ConfigFields serviceType={service.service_type} fields={service.fields.filter((field) => !['floor', 'bed_configuration', 'amenities', 'equipment', 'seating_area', 'layouts'].includes(field.key))}
                    value={settings} onChange={setSettings} inherited={service.platform_defaults} level="service" currency={business.currency}
                    only={external ? ['check_in_time', 'check_out_time', 'default_duration_minutes', 'min_duration_minutes', 'increment_minutes'] : undefined} />
                <ErrorNotice error={save.error} onDismiss={() => save.setError(null)} />
                {save.saved && <Notice tone="good">{save.saved}</Notice>}
                <Button busy={save.busy} onClick={() => apply({ settings }, 'Service defaults saved.')}>Save service defaults</Button>
            </div>
        </Card>
    );
}

function ClosuresTab() {
    const { api, business, detail } = useDashboard();
    const closures = useAsync(() => api.closures(), [business.id]);
    const [form, setForm] = useState({ service_type: '', start_date: '', end_date: '', reason: '' });
    const save = useSave();
    return (
        <Card title="Closure dates" hint="Nothing can be booked on these business-local dates.">
            <div className="grid gap-3 md:grid-cols-5">
                <Select value={form.service_type} onChange={(event) => setForm({ ...form, service_type: event.target.value })} aria-label="Service">
                    <option value="">Whole business</option>
                    {detail.services.filter((item) => item.enabled).map((item) => <option key={item.service_type} value={item.service_type}>{SERVICE_LABEL[item.service_type]}</option>)}
                </Select>
                <TextInput type="date" value={form.start_date} onChange={(event) => setForm({ ...form, start_date: event.target.value, end_date: form.end_date || event.target.value })} aria-label="From" />
                <TextInput type="date" value={form.end_date} min={form.start_date} onChange={(event) => setForm({ ...form, end_date: event.target.value })} aria-label="Until" />
                <TextInput placeholder="Reason" value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
                <Button busy={save.busy} disabled={!form.start_date || !form.end_date} onClick={async () => {
                    if (await save.run(() => api.addClosure({ ...form, service_type: (form.service_type || null) as ServiceType | null }), 'Closure added.')) { setForm({ service_type: '', start_date: '', end_date: '', reason: '' }); await closures.reload(); }
                }}>Add closure</Button>
            </div>
            <div className="mt-4 space-y-2">
                <ErrorNotice error={save.error || closures.error} />
                {closures.loading && !closures.data ? <Loading /> : !closures.data?.length ? <Empty title="No closures planned" /> : closures.data.map((row) => (
                    <div key={row.id} className="flex items-center justify-between rounded-xl border border-parchment px-4 py-2 text-sm">
                        <span><strong>{row.start_date}{row.end_date !== row.start_date ? ` → ${row.end_date}` : ''}</strong> · {row.service_type ? SERVICE_LABEL[row.service_type as ServiceType] : 'Whole business'}{row.reason ? ` · ${row.reason}` : ''}</span>
                        <Button tone="ghost" onClick={async () => { await api.removeClosure(row.id); await closures.reload(); }}>Remove</Button>
                    </div>
                ))}
            </div>
        </Card>
    );
}

function TeamTab() {
    const { api, business, detail } = useDashboard();
    const members = useAsync(() => api.members(), [business.id]);
    const [email, setEmail] = useState('');
    const [role, setRole] = useState<Role>('staff');
    const save = useSave();
    return (
        <Card title="Team access" hint="Owners and admins manage configuration, integrations and access. Staff manage reservations and daily operations.">
            <form className="grid gap-3 md:grid-cols-4" onSubmit={async (event) => {
                event.preventDefault();
                if (await save.run(() => api.saveMember(email.trim(), role), 'Access updated.')) { setEmail(''); await members.reload(); }
            }}>
                <div className="md:col-span-2"><TextInput type="email" required placeholder="Email of an existing account" value={email} onChange={(event) => setEmail(event.target.value)} /></div>
                <Select value={role} onChange={(event) => setRole(event.target.value as Role)} aria-label="Role">
                    <option value="staff">Staff</option><option value="admin">Admin</option>{detail.role === 'owner' && <option value="owner">Owner</option>}
                </Select>
                <Button type="submit" busy={save.busy}>Grant access</Button>
            </form>
            <div className="mt-4 space-y-2">
                <ErrorNotice error={save.error || members.error} onDismiss={() => save.setError(null)} />
                {save.saved && <Notice tone="good">{save.saved}</Notice>}
                {members.loading && !members.data ? <Loading /> : members.data?.map((member) => (
                    <div key={member.id} className="flex items-center justify-between rounded-xl border border-parchment px-4 py-2 text-sm">
                        <span><strong>{member.email}</strong>{member.name ? ` · ${member.name}` : ''}</span>
                        <span className="flex items-center gap-3">
                            <Badge tone={member.role === 'owner' ? 'good' : 'neutral'}>{member.role}</Badge>
                            <Button tone="danger" onClick={async () => { if (window.confirm(`Remove ${member.email}'s access?`) && await save.run(() => api.removeMember(member.id), 'Access removed.')) await members.reload(); }}>Remove</Button>
                        </span>
                    </div>
                ))}
            </div>
        </Card>
    );
}

function NotificationsTab() {
    const { api, business } = useDashboard();
    const [settings, setSettings] = useState<NotificationSettings>({ provider: 'slack', webhook_url: '', alert_email: '' });
    const [calendarId, setCalendarId] = useState('');
    const [calendarState, setCalendarState] = useState<{ enabled: boolean; uses_deployment_calendar: boolean } | null>(null);
    const save = useSave();
    const calendar = useSave();
    const loaded = useAsync(async () => {
        const [notifications, cal] = await Promise.all([api.notifications(), api.calendar()]);
        setSettings(notifications); setCalendarId(cal.calendar_id); setCalendarState(cal);
        return true;
    }, [business.id]);

    if (loaded.loading && !loaded.data) return <Loading />;
    return (
        <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Staff notifications">
                <div className="space-y-4">
                    <ErrorNotice error={loaded.error || save.error} />
                    <Field label="Provider"><Select value={settings.provider} onChange={(event) => setSettings({ ...settings, provider: event.target.value as 'slack' | 'teams' })}><option value="slack">Slack</option><option value="teams">Microsoft Teams</option></Select></Field>
                    <Field label="Webhook URL"><TextInput value={settings.webhook_url} onChange={(event) => setSettings({ ...settings, webhook_url: event.target.value })} placeholder="https://hooks…" /></Field>
                    <Field label="Alert email"><TextInput type="email" value={settings.alert_email} onChange={(event) => setSettings({ ...settings, alert_email: event.target.value })} /></Field>
                    {save.saved && <Notice tone="good">{save.saved}</Notice>}
                    <Button busy={save.busy} onClick={() => save.run(() => api.saveNotifications(settings))}>Save notifications</Button>
                </div>
            </Card>
            <Card title="Google Calendar" hint="A display copy of reservations. It never changes a reservation.">
                <div className="space-y-4">
                    <Field label="Calendar ID" hint="Share the calendar with the deployment's service account, then paste its ID.">
                        <TextInput value={calendarId} onChange={(event) => setCalendarId(event.target.value)} placeholder="name@group.calendar.google.com" />
                    </Field>
                    <div className="flex flex-wrap gap-2">
                        <Badge tone={calendarState?.enabled ? 'good' : 'neutral'}>{calendarState?.enabled ? 'Sync on' : 'Sync off'}</Badge>
                        {calendarState?.uses_deployment_calendar && <Badge tone="info">Using the deployment calendar</Badge>}
                    </div>
                    <Notice tone="info">Deleting an event in Google Calendar does not cancel the reservation. Failed updates are retried automatically.</Notice>
                    <ErrorNotice error={calendar.error} />
                    {calendar.saved && <Notice tone="good">{calendar.saved}</Notice>}
                    <div className="flex flex-wrap gap-2">
                        <Button busy={calendar.busy} onClick={async () => { if (await calendar.run(() => api.saveCalendar(calendarId.trim()))) setCalendarState(await api.calendar()); }}>Save calendar</Button>
                        <Button tone="ghost" busy={calendar.busy} onClick={async () => {
                            calendar.setError(null);
                            try {
                                const result = await api.repairCalendar();
                                calendar.setSaved(result.enabled ? `Calendar repair: ${result.synced.length} updated, ${result.errors.length} failed (will retry), ${result.skipped.length} skipped.` : 'Calendar sync is off for this business.');
                            } catch (err) { calendar.setError(toApiError(err)); }
                        }}>Re-send reservations to Calendar</Button>
                    </div>
                </div>
            </Card>
        </div>
    );
}

function AuditTab() {
    const { api, business } = useDashboard();
    const [entity, setEntity] = useState('');
    const logs = useAsync(() => api.audit(100, entity || undefined), [entity, business.id]);
    return (
        <Card title="Audit history" hint="Who changed what, and when."
            action={<Select className="max-w-[14rem]" value={entity} onChange={(event) => setEntity(event.target.value)} aria-label="Filter by type">
                <option value="">Everything</option>
                {['booking', 'resource', 'resource_type', 'service_settings', 'business', 'membership', 'integration', 'notification_settings', 'closure'].map((item) => <option key={item} value={item}>{item.replace(/_/g, ' ')}</option>)}
            </Select>}>
            <ErrorNotice error={logs.error} />
            {logs.loading && !logs.data ? <Loading /> : !logs.data?.length ? <Empty title="No changes recorded yet" /> : (
                <div className="space-y-3">
                    {logs.data.map((log) => (
                        <div key={log.id} className="rounded-xl border border-parchment p-4">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-sm font-bold text-ink">{log.action.replace(/_/g, ' ')} · {log.entity.replace(/_/g, ' ')}{log.entity_id ? ` #${log.entity_id}` : ''}</p>
                                <p className="text-xs text-ink/50">{log.actor_email || 'system'} · {inZone(log.created_at, business.timezone)}</p>
                            </div>
                            {!!log.change_summary?.length && (
                                <ul className="mt-2 space-y-1 text-xs text-ink/70">
                                    {log.change_summary.slice(0, 10).map((change) => (
                                        <li key={change.field}><span className="font-bold">{change.field}</span>: <span className="text-ink/50">{String(typeof change.before === 'object' ? JSON.stringify(change.before) : change.before || '—')}</span> → {String(typeof change.after === 'object' ? JSON.stringify(change.after) : change.after || '—')}</li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </Card>
    );
}
