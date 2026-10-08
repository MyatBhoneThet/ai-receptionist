'use client';

import React, { useState } from 'react';
import DashboardShell, { useAsync, useDashboard } from '../../components/dashboard/DashboardShell';
import { Badge, Button, Card, Empty, ErrorNotice, Field, Loading, Notice, TextInput } from '../../components/dashboard/ui';
import { ApiError, Integration, toApiError } from '../../lib/api';
import { SERVICE_LABEL, ago, inZone } from '../../lib/format';
import type { ServiceType } from '../../lib/api';

export default function IntegrationsPage() {
    return (
        <DashboardShell eyebrow="Integrations" title="External systems and synchronization" managerOnly>
            <Integrations />
        </DashboardShell>
    );
}

const yesNo = (value: unknown) => (value ? 'Yes' : 'No');

function Integrations() {
    const { api, business, detail, reload } = useDashboard();
    const list = useAsync(() => api.integrations(), [business.id]);
    const jobs = useAsync(() => api.jobs(), [business.id]);
    const [name, setName] = useState('');
    const [error, setError] = useState<ApiError | null>(null);
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState<number | null>(null);

    const run = async (work: () => Promise<unknown>, message: string) => {
        setBusy(true); setError(null); setNotice('');
        try { await work(); setNotice(message); await Promise.all([list.reload(), jobs.reload(), reload()]); } catch (err) { setError(toApiError(err)); } finally { setBusy(false); }
    };
    const usedBy = (integration: Integration) => detail.services.filter((service) => service.integration_id === integration.id).map((service) => SERVICE_LABEL[service.service_type]);
    const mock = list.data?.connectors.find((connector) => connector.key === 'mock');

    return (
        <>
            <Notice tone="warn" title="No production PMS connector is installed">
                No reservation-system vendor has been selected, so there is no live connector yet. The only connector available is a clearly
                labelled <strong>mock</strong> for development and testing. It is not a real reservation system, and customer booking through it
                stays off outside development. A real connector needs the vendor's official API documentation, credentials and any approval they require.
            </Notice>
            <ErrorNotice error={error || list.error} onDismiss={() => setError(null)} />
            {notice && <Notice tone="good" onDismiss={() => setNotice('')}>{notice}</Notice>}

            <Card title="Connections" hint="Credentials stay on the server, encrypted at rest. They are never shown here, logged, or given to the AI.">
                {list.loading && !list.data ? <Loading /> : (
                    <div className="space-y-4">
                        {!list.data?.integrations.length && <Empty title="No connections yet">Add the mock connection below to try external-system mode.</Empty>}
                        {list.data?.integrations.map((integration) => (
                            <div key={integration.id} className="rounded-xl border border-parchment p-4">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div>
                                        <p className="text-base font-bold text-ink">{integration.name}</p>
                                        <p className="text-xs text-ink/60">{integration.provider_label}</p>
                                        <p className="mt-1 text-xs text-ink/50">Used for: {usedBy(integration).join(', ') || 'no service yet — choose it under Settings → Services'}</p>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        {integration.is_mock && <Badge tone="warn">Mock · not live</Badge>}
                                        <Badge tone={integration.status === 'connected' ? 'good' : integration.status === 'error' ? 'bad' : 'neutral'}>{integration.status}</Badge>
                                    </div>
                                </div>
                                <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-ink/70 md:grid-cols-3">
                                    <div>Last tested: <strong>{ago(integration.last_tested_at)}</strong>{integration.last_test_result ? ` — ${integration.last_test_result.message}` : ''}</div>
                                    <div>Last reconciled: <strong>{ago(integration.last_reconciled_at)}</strong></div>
                                    <div>{integration.last_error ? <span className="text-rose-700">Last error: {integration.last_error}</span> : 'No sync error'}</div>
                                </dl>
                                <div className="mt-3 flex flex-wrap gap-2">
                                    <Button tone="ghost" busy={busy} onClick={() => run(() => api.testIntegration(integration.id), 'Connection tested.')}>Test connection</Button>
                                    <Button tone="ghost" busy={busy} onClick={() => run(async () => {
                                        const summary = await api.importInventory(integration.id);
                                        setNotice(`Imported ${summary.types_created} type(s) and ${summary.resources_created} room(s). ${summary.skipped?.length ? `${summary.skipped.length} skipped.` : ''}`);
                                    }, 'Inventory imported.')}>Import & map inventory</Button>
                                    <Button tone="ghost" busy={busy} onClick={() => run(() => api.reconcile(integration.id), 'Reconciliation run.')}>Reconcile now</Button>
                                    <Button tone="ghost" onClick={() => setOpen(open === integration.id ? null : integration.id)}>{open === integration.id ? 'Hide details' : 'Capabilities, mappings & history'}</Button>
                                </div>
                                {open === integration.id && <IntegrationDetail integration={integration} />}
                            </div>
                        ))}

                        {mock && (
                            <form className="flex flex-wrap items-end gap-3 border-t border-parchment pt-4" onSubmit={(event) => {
                                event.preventDefault();
                                run(async () => {
                                    const created = await api.createIntegration({ provider_key: 'mock', name: name.trim() || 'Mock PMS' });
                                    setName('');
                                    setNotice(`Mock connection created. Webhook signing secret (shown once): ${created.webhook_secret_once}`);
                                }, 'Mock connection created.');
                            }}>
                                <div className="min-w-[16rem] flex-1"><Field label="Add a mock connection" hint={mock.label}><TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="Name, e.g. Front desk PMS (mock)" /></Field></div>
                                <Button type="submit" busy={busy}>Add mock connection</Button>
                            </form>
                        )}
                    </div>
                )}
            </Card>

            <Card title="Background synchronization" hint="Durable jobs survive restarts and retry with backoff. A failed sync never changes a reservation's status."
                action={<Button tone="ghost" busy={busy} onClick={() => run(() => api.runJobs(), 'Due jobs were run.')}>Run pending jobs now</Button>}>
                {jobs.loading && !jobs.data ? <Loading /> : (
                    <>
                        <div className="mb-3 flex flex-wrap gap-2">
                            {['queued', 'running', 'succeeded', 'dead'].map((status) => (
                                <Badge key={status} tone={status === 'dead' && jobs.data?.counts.dead ? 'bad' : status === 'queued' && jobs.data?.counts.queued ? 'warn' : 'neutral'}>
                                    {status === 'dead' ? 'gave up' : status}: {jobs.data?.counts[status] || 0}
                                </Badge>
                            ))}
                        </div>
                        {!jobs.data?.recent.length ? <Empty title="No synchronization jobs yet" /> : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-xs">
                                    <thead><tr className="text-[10px] font-bold uppercase tracking-widest text-ink/40"><th className="py-2 pr-4">Job</th><th className="py-2 pr-4">Status</th><th className="py-2 pr-4">Attempts</th><th className="py-2 pr-4">Next try</th><th className="py-2">Last error</th></tr></thead>
                                    <tbody className="divide-y divide-parchment">
                                        {jobs.data.recent.map((job) => (
                                            <tr key={job.id}>
                                                <td className="py-2 pr-4 font-medium text-ink">{job.kind.replace(/_/g, ' ')} <span className="text-ink/40">{job.dedupe_key}</span></td>
                                                <td className="py-2 pr-4"><Badge tone={job.status === 'succeeded' ? 'good' : job.status === 'dead' ? 'bad' : 'warn'}>{job.status === 'dead' ? 'gave up' : job.status}</Badge></td>
                                                <td className="py-2 pr-4">{job.attempts}/{job.max_attempts}</td>
                                                <td className="py-2 pr-4">{job.status === 'queued' ? inZone(job.run_after, business.timezone) : '—'}</td>
                                                <td className="py-2 text-rose-700">{job.last_error || ''}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </>
                )}
            </Card>
        </>
    );
}

function IntegrationDetail({ integration }: { integration: Integration }) {
    const { api, business } = useDashboard();
    const mappings = useAsync(() => api.mappings(integration.id), [integration.id]);
    const health = useAsync(() => api.integrationHealth(integration.id), [integration.id]);
    const capabilities = integration.capabilities || {};
    const services = (capabilities.services || {}) as Record<string, { supported: boolean; inventory_model?: string }>;

    return (
        <div className="mt-4 space-y-5 border-t border-parchment pt-4">
            <div>
                <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-ink/50">Declared capabilities</p>
                {!Object.keys(capabilities).length ? <p className="text-xs text-ink/60">Test the connection to discover what this system supports.</p> : (
                    <div className="grid gap-2 text-xs text-ink/70 md:grid-cols-2">
                        {(['hotel', 'restaurant', 'meeting'] as ServiceType[]).map((service) => (
                            <div key={service}>{SERVICE_LABEL[service]}: <strong>{services[service]?.supported ? `supported (${services[service].inventory_model === 'room_type' ? 'sells room types; physical room assigned later' : 'physical units'})` : 'not supported'}</strong></div>
                        ))}
                        <div>Physical room assignment at booking: <strong>{yesNo(capabilities.physical_assignment)}</strong></div>
                        <div>Webhooks: <strong>{yesNo(capabilities.webhooks)}</strong></div>
                        <div>Idempotent booking creation: <strong>{yesNo(capabilities.idempotent_create)}</strong></div>
                        <div>Look up a request by our reference: <strong>{yesNo(capabilities.lookup_by_correlation)}</strong></div>
                        <div>Modify / cancel through API: <strong>{yesNo(capabilities.modify)} / {yesNo(capabilities.cancel)}</strong></div>
                        <div>Operational updates accepted: <strong>{(capabilities.operational_updates || []).join(', ').replace(/_/g, ' ') || 'none'}</strong></div>
                    </div>
                )}
            </div>

            <div>
                <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-ink/50">Inventory mapping</p>
                {mappings.loading && !mappings.data ? <Loading /> : !mappings.data?.length ? <p className="text-xs text-ink/60">Nothing imported yet. Assign this connection to a service, then use “Import & map inventory”.</p> : (
                    <table className="w-full text-left text-xs">
                        <thead><tr className="text-[10px] font-bold uppercase tracking-widest text-ink/40"><th className="py-1 pr-4">External</th><th className="py-1 pr-4">Kind</th><th className="py-1 pr-4">Mapped to (read-only locally)</th><th className="py-1">Last seen</th></tr></thead>
                        <tbody className="divide-y divide-parchment">
                            {mappings.data.map((row) => (
                                <tr key={row.id}>
                                    <td className="py-1.5 pr-4 font-medium text-ink">{row.external_name} <span className="text-ink/40">{row.external_id}</span></td>
                                    <td className="py-1.5 pr-4">{row.kind === 'resource_type' ? 'type' : 'room'}</td>
                                    <td className="py-1.5 pr-4">{row.resource_type_name || row.resource_code || <span className="text-amber-700">not mapped</span>}</td>
                                    <td className="py-1.5">{ago(row.last_seen_at)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            <div>
                <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-ink/50">Needs attention</p>
                {health.data && !health.data.attention.length && !health.data.unresolved_commands.length ? <p className="text-xs text-ink/60">Nothing is waiting on this system.</p> : (
                    <ul className="space-y-1 text-xs">
                        {health.data?.attention.map((row) => <li key={`a${row.id}`} className="text-amber-800">Reservation #{row.id} ({row.reservation_name}): {row.attention_reason || `sync ${row.sync_status}`}</li>)}
                        {health.data?.unresolved_commands.map((row) => <li key={`c${row.id}`} className="text-amber-800">{row.command} request for reservation #{row.booking_id || '—'} has no confirmed outcome yet ({row.status.replace(/_/g, ' ')}).</li>)}
                    </ul>
                )}
            </div>

            <div>
                <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-ink/50">Synchronization history</p>
                {health.loading && !health.data ? <Loading /> : !health.data?.events.length ? <p className="text-xs text-ink/60">No events yet.</p> : (
                    <div className="max-h-64 overflow-auto">
                        <table className="w-full text-left text-xs">
                            <tbody className="divide-y divide-parchment">
                                {health.data.events.map((event) => (
                                    <tr key={event.id}>
                                        <td className="py-1.5 pr-4 text-ink/50">{inZone(event.created_at, business.timezone)}</td>
                                        <td className="py-1.5 pr-4">{event.direction === 'inbound' ? '← from system' : '→ to system'}</td>
                                        <td className="py-1.5 pr-4 font-medium text-ink">{event.event_type}</td>
                                        <td className="py-1.5 pr-4">{event.external_reservation_id || ''}</td>
                                        <td className="py-1.5"><Badge tone={event.outcome === 'applied' ? 'good' : event.outcome === 'failed' || event.outcome === 'unknown' ? 'bad' : 'neutral'}>{event.outcome}</Badge></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {integration.is_mock && <MockControls integration={integration} onChanged={() => { mappings.reload(); health.reload(); }} />}
        </div>
    );
}

/** Development-only: change the MOCK system directly, as if a front desk had. */
function MockControls({ integration, onChanged }: { integration: Integration; onChanged: () => void }) {
    const { api } = useDashboard();
    const mock = useAsync(() => api.mock(integration.id), [integration.id]);
    const [error, setError] = useState<ApiError | null>(null);
    const run = async (work: () => Promise<unknown>) => { setError(null); try { await work(); await mock.reload(); onChanged(); } catch (err) { setError(toApiError(err)); } };
    if (mock.error?.status === 404) return null;   // not offered in production
    const faults = mock.data?.settings?.faults || {};

    return (
        <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50/50 p-4">
            <p className="text-[11px] font-bold uppercase tracking-widest text-amber-800">Mock system controls — development only</p>
            <p className="mt-1 text-xs text-amber-900/80">These change the mock's own records, separate from this dashboard, to rehearse outages and changes made outside the platform.</p>
            <ErrorNotice error={error} />
            {mock.loading && !mock.data ? <Loading /> : mock.data && (
                <div className="mt-3 space-y-3 text-xs">
                    <div className="flex flex-wrap gap-2">
                        <Button tone="ghost" onClick={() => run(() => api.seedMockInventory(integration.id, [
                            { service_type: 'hotel', external_id: 'STD', name: 'Standard room', capacity: 2, rate: '1800', units: ['101', '102', '103'].map((code) => ({ external_id: `U-${code}`, code })) },
                            { service_type: 'hotel', external_id: 'DLX', name: 'Deluxe room', capacity: 3, rate: '2800', units: ['201', '202'].map((code) => ({ external_id: `U-${code}`, code })) }]))}>
                            Load sample rooms
                        </Button>
                        <Button tone={faults.outage ? 'danger' : 'ghost'} onClick={() => run(() => api.updateMock(integration.id, { faults: { outage: !faults.outage } }))}>
                            {faults.outage ? 'End simulated outage' : 'Simulate outage'}
                        </Button>
                        <Button tone="ghost" onClick={() => run(() => api.updateMock(integration.id, { faults: { timeout_after_accept: 1 } }))}>
                            Next booking: accept, then time out{faults.timeout_after_accept ? ' (armed)' : ''}
                        </Button>
                    </div>
                    <p className="text-ink/60">Mock inventory: {mock.data.inventory.types.map((type: any) => `${type.name} ×${type.units}`).join(', ') || 'none'}</p>
                    {mock.data.reservations.length > 0 && (
                        <table className="w-full text-left">
                            <tbody className="divide-y divide-amber-200">
                                {mock.data.reservations.map((row) => (
                                    <tr key={row.external_id}>
                                        <td className="py-1.5 pr-3 font-medium text-ink">{row.external_id}</td>
                                        <td className="py-1.5 pr-3">{row.guest_name}</td>
                                        <td className="py-1.5 pr-3">{row.status}{row.unit_external_id ? ` · room ${row.unit_external_id.replace('U-', '')}` : ' · no room yet'}</td>
                                        <td className="py-1.5 text-right">
                                            {row.status === 'confirmed' && !row.unit_external_id && mock.data!.inventory.units[0] && (
                                                <button className="mr-3 font-bold underline" onClick={() => run(() => api.changeMockReservation(integration.id, row.external_id, { unit_external_id: mock.data!.inventory.units[0].external_id }))}>Assign a room in the PMS</button>
                                            )}
                                            {row.status !== 'cancelled' && <button className="font-bold underline" onClick={() => run(() => api.changeMockReservation(integration.id, row.external_id, { status: 'cancelled' }))}>Cancel in the PMS</button>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                    <p className="text-ink/50">After changing the mock, press “Reconcile now” to pull the change in.</p>
                </div>
            )}
        </div>
    );
}
