'use client';

import React, { useMemo, useState } from 'react';
import DashboardShell, { useAsync, useDashboard } from '../../components/dashboard/DashboardShell';
import ConfigFields, { describeValue } from '../../components/dashboard/ConfigFields';
import { Badge, Button, Card, Empty, ErrorNotice, Field, Loading, Modal, Notice, SourceBadge, Tabs, TextInput } from '../../components/dashboard/ui';
import { ApiError, BatchPreview, Resource, ResourceType, ServiceType, toApiError } from '../../lib/api';
import { OPERATIONAL_LABEL, SERVICE_LABEL, SERVICE_UNIT } from '../../lib/format';

const CAPACITY_KEY: Record<ServiceType, string> = { hotel: 'max_guests', restaurant: 'seating_capacity', meeting: 'layouts' };
const PROBLEM: Record<string, string> = { already_exists: 'already exists', duplicate_in_batch: 'repeated in this batch', invalid_code: 'not a valid code' };

export default function InventoryPage() {
    return (
        <DashboardShell eyebrow="Inventory" title="Types and individual rooms & tables" managerOnly>
            <Inventory />
        </DashboardShell>
    );
}

function Inventory() {
    const { api, detail, business } = useDashboard();
    const enabled = detail.services.filter((service) => service.enabled);
    const [service, setService] = useState<ServiceType>(enabled[0]?.service_type || 'restaurant');
    const current = detail.services.find((item) => item.service_type === service)!;
    const types = useAsync(() => api.types(service), [service, business.id]);
    const resources = useAsync(() => api.resources(service), [service, business.id]);
    const [editType, setEditType] = useState<ResourceType | 'new' | null>(null);
    const [batchFor, setBatchFor] = useState<ResourceType | null>(null);
    const [editResource, setEditResource] = useState<Resource | null>(null);
    const [error, setError] = useState<ApiError | null>(null);
    const external = current.booking_source === 'external';
    const refresh = async () => { await Promise.all([types.reload(), resources.reload()]); };

    if (!enabled.length) return <Empty title="No services are enabled">Enable a service in Settings to add inventory.</Empty>;

    return (
        <>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <Tabs value={service} onChange={setService} options={enabled.map((item) => ({ value: item.service_type, label: SERVICE_LABEL[item.service_type] }))} />
                <SourceBadge source={current.booking_source} name={current.integration?.name} mock={current.integration?.environment === 'mock'} />
            </div>

            {external && (
                <Notice tone="info" title={`${SERVICE_LABEL[service]} are owned by ${current.integration?.name || 'the connected system'}`}>
                    Types, capacities, prices and availability come from that system and are read-only here. You can edit a local display name;
                    it never overrides the provider. Import or refresh inventory from <a className="underline" href="/integrations">Integrations</a>.
                </Notice>
            )}
            <ErrorNotice error={error || types.error || resources.error} onDismiss={() => setError(null)} />

            <Card title={`${SERVICE_UNIT[service][0].toUpperCase()}${SERVICE_UNIT[service].slice(1)} types`}
                hint="A type holds the defaults. Individual rooms or tables inherit them and may override any value."
                action={!external && <Button onClick={() => setEditType('new')}>Add type</Button>}>
                {types.loading && !types.data ? <Loading /> : !types.data?.length ? (
                    <Empty title="No types yet">{external ? 'Import inventory from the connected system.' : `Create a type such as "${service === 'restaurant' ? 'Standard indoor table' : service === 'hotel' ? 'Deluxe room' : 'Boardroom'}", then add its ${SERVICE_UNIT[service]}s.`}</Empty>
                ) : (
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {types.data.map((type) => (
                            <div key={type.id} className="rounded-xl border border-parchment p-4">
                                <div className="flex items-start justify-between gap-2">
                                    <div>
                                        <p className="text-base font-bold text-ink">{type.name}</p>
                                        <p className="text-xs text-ink/60">{type.resource_count} {SERVICE_UNIT[service]}{type.resource_count === 1 ? '' : 's'}</p>
                                    </div>
                                    <div className="flex flex-col items-end gap-1">
                                        {!type.is_active && <Badge tone="warn">Inactive</Badge>}
                                        {type.managed_by === 'external' && <Badge tone="info">Provider-owned</Badge>}
                                    </div>
                                </div>
                                <dl className="mt-3 space-y-1 text-xs text-ink/70">
                                    {type.fields.filter((field) => [CAPACITY_KEY[service], 'base_rate', 'min_spend', 'deposit'].includes(field.key)).map((field) => (
                                        <div key={field.key} className="flex justify-between gap-3">
                                            <dt className="text-ink/50">{field.label}</dt>
                                            <dd className="text-right font-medium">{describeValue(field.key, type.effective.values[field.key], business.currency)}</dd>
                                        </div>
                                    ))}
                                </dl>
                                <div className="mt-4 flex flex-wrap gap-2">
                                    <Button tone="ghost" onClick={() => setEditType(type)}>{type.managed_by === 'external' ? 'View' : 'Edit defaults'}</Button>
                                    {type.managed_by !== 'external' && <Button tone="ghost" onClick={() => setBatchFor(type)}>Add {SERVICE_UNIT[service]}s</Button>}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </Card>

            <Card title={`Individual ${SERVICE_UNIT[service]}s`} hint="Each row is one physical room or table with its own stable identifier.">
                {resources.loading && !resources.data ? <Loading /> : !resources.data?.length ? (
                    <Empty title={`No ${SERVICE_UNIT[service]}s yet`}>Use “Add {SERVICE_UNIT[service]}s” on a type to create several at once.</Empty>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead>
                                <tr className="text-[10px] font-bold uppercase tracking-widest text-ink/40">
                                    <th className="py-2 pr-4">Code</th><th className="py-2 pr-4">Type</th><th className="py-2 pr-4">{detail.services.find((item) => item.service_type === service)?.fields.find((field) => field.key === CAPACITY_KEY[service])?.label}</th>
                                    <th className="py-2 pr-4">Own settings</th><th className="py-2 pr-4">State</th><th className="py-2" />
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-parchment">
                                {resources.data.map((resource) => {
                                    const overridden = Object.keys(resource.overrides);
                                    return (
                                        <tr key={resource.id}>
                                            <td className="py-3 pr-4 font-bold text-ink">{resource.code}{resource.name ? <span className="ml-2 font-normal text-ink/50">{resource.name}</span> : null}</td>
                                            <td className="py-3 pr-4 text-ink/70">{resource.resource_type_name}</td>
                                            <td className="py-3 pr-4 text-ink/70">{describeValue(CAPACITY_KEY[service], resource.effective.values[CAPACITY_KEY[service]])}</td>
                                            <td className="py-3 pr-4">
                                                {overridden.length ? <Badge tone="warn">{overridden.length} override{overridden.length === 1 ? '' : 's'}</Badge> : <span className="text-xs text-ink/40">Inherits everything</span>}
                                            </td>
                                            <td className="py-3 pr-4">
                                                <div className="flex flex-wrap gap-1">
                                                    {!resource.is_active && <Badge tone="warn">Inactive</Badge>}
                                                    <Badge tone={resource.operational_status === 'ready' ? 'good' : 'neutral'}>{OPERATIONAL_LABEL[resource.operational_status]}</Badge>
                                                </div>
                                            </td>
                                            <td className="py-3 text-right"><Button tone="ghost" onClick={() => setEditResource(resource)}>{resource.managed_by === 'external' ? 'View' : 'Edit'}</Button></td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>

            {editType && <TypeModal service={service} type={editType === 'new' ? null : editType} onClose={() => setEditType(null)} onSaved={async () => { setEditType(null); await refresh(); }} />}
            {batchFor && <BatchModal type={batchFor} onClose={() => setBatchFor(null)} onSaved={async () => { setBatchFor(null); await refresh(); }} />}
            {editResource && <ResourceModal resource={editResource} types={types.data || []} onClose={() => setEditResource(null)} onSaved={async () => { setEditResource(null); await refresh(); }} />}
        </>
    );
}

function ConflictConfirm({ error, onConfirm, busy }: { error: ApiError | null; onConfirm: () => void; busy: boolean }) {
    if (error?.code !== 'config_conflict' || !error.details?.acknowledge_with) return null;
    return (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
            <span>Existing reservations keep the terms they were booked on. Save anyway and review them afterwards?</span>
            <Button tone="danger" busy={busy} onClick={onConfirm}>Save anyway</Button>
        </div>
    );
}

function TypeModal({ service, type, onClose, onSaved }: { service: ServiceType; type: ResourceType | null; onClose: () => void; onSaved: () => void }) {
    const { api, detail, business } = useDashboard();
    const serviceInfo = detail.services.find((item) => item.service_type === service)!;
    const [name, setName] = useState(type?.name || '');
    const [prefix, setPrefix] = useState(type?.code_prefix || '');
    const [defaults, setDefaults] = useState<Record<string, any>>(type?.defaults || {});
    const [active, setActive] = useState(type?.is_active ?? true);
    const [error, setError] = useState<ApiError | null>(null);
    const [busy, setBusy] = useState(false);
    const readOnly = type?.managed_by === 'external';

    const save = async (acknowledge = false) => {
        setBusy(true); setError(null);
        try {
            if (type) await api.updateType(type.id, readOnly ? { name } : { name, code_prefix: prefix, defaults, is_active: active, ...(acknowledge ? { acknowledge_conflicts: true } : {}) });
            else await api.createType({ service_type: service, name, code_prefix: prefix, defaults });
            onSaved();
        } catch (err) { setError(toApiError(err)); } finally { setBusy(false); }
    };
    const archive = async () => {
        if (!type || !window.confirm(`Archive the type "${type.name}"?`)) return;
        setBusy(true);
        try { await api.archiveType(type.id); onSaved(); } catch (err) { setError(toApiError(err)); } finally { setBusy(false); }
    };

    return (
        <Modal wide title={type ? `${type.name} — type defaults` : `New ${SERVICE_UNIT[service]} type`} onClose={onClose}>
            <div className="space-y-4">
                {readOnly && <Notice tone="info">Provider-owned. Only the local display name can be changed.</Notice>}
                <div className="grid gap-4 md:grid-cols-2">
                    <Field label="Type name"><TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Private table" /></Field>
                    {!readOnly && <Field label="Code prefix" hint="Used when generating codes, e.g. T → T01, T02…"><TextInput value={prefix} onChange={(event) => setPrefix(event.target.value)} /></Field>}
                </div>
                <ConfigFields serviceType={service} fields={serviceInfo.fields.filter((field) => field.key !== 'floor')} value={defaults} onChange={setDefaults}
                    inherited={serviceInfo.effective.values} inheritedSources={serviceInfo.effective.sources} level="type" readOnly={readOnly} currency={business.currency} />
                {type && !readOnly && (
                    <label className="flex items-center gap-2 text-sm text-ink/80">
                        <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Active — can be booked
                    </label>
                )}
                <ErrorNotice error={error} />
                <ConflictConfirm error={error} busy={busy} onConfirm={() => save(true)} />
                <div className="flex justify-between">
                    <div>{type && !readOnly && <Button tone="danger" onClick={archive} busy={busy}>Archive type</Button>}</div>
                    <div className="flex gap-2">
                        <Button tone="ghost" onClick={onClose}>Cancel</Button>
                        <Button onClick={() => save()} busy={busy} disabled={!name.trim()}>Save</Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function BatchModal({ type, onClose, onSaved }: { type: ResourceType; onClose: () => void; onSaved: () => void }) {
    const { api } = useDashboard();
    const [mode, setMode] = useState<'generate' | 'list'>('generate');
    const [quantity, setQuantity] = useState(10);
    const [prefix, setPrefix] = useState(type.code_prefix || '');
    const [start, setStart] = useState(1);
    const [pad, setPad] = useState(2);
    const [list, setList] = useState('');
    const [preview, setPreview] = useState<BatchPreview | null>(null);
    const [error, setError] = useState<ApiError | null>(null);
    const [busy, setBusy] = useState(false);
    const unit = SERVICE_UNIT[type.service_type];

    const input = useMemo(() => (mode === 'generate'
        ? { resource_type_id: type.id, quantity, prefix, start_number: start, pad }
        : { resource_type_id: type.id, codes: list.split(/[\n,]/).map((item) => item.trim()).filter(Boolean) }), [mode, type.id, quantity, prefix, start, pad, list]);

    const runPreview = async () => {
        setBusy(true); setError(null);
        try { setPreview(await api.previewBatch(input)); } catch (err) { setPreview(null); setError(toApiError(err)); } finally { setBusy(false); }
    };
    const create = async () => {
        setBusy(true); setError(null);
        try { await api.createBatch(input); onSaved(); } catch (err) { setError(toApiError(err)); await runPreview(); } finally { setBusy(false); }
    };
    const invalidate = () => setPreview(null);

    return (
        <Modal wide title={`Add ${unit}s to “${type.name}”`} onClose={onClose}>
            <div className="space-y-4">
                <p className="text-xs text-ink/60">Quantity is a shortcut: each code below becomes its own physical {unit} with a stable identifier. All are saved together, or none are.</p>
                <Tabs value={mode} onChange={(value) => { setMode(value); invalidate(); }} options={[{ value: 'generate', label: 'Generate codes' }, { value: 'list', label: 'Type codes' }]} />
                {mode === 'generate' ? (
                    <div className="grid gap-4 md:grid-cols-4">
                        <Field label="Quantity"><TextInput type="number" min={1} max={500} value={quantity} onChange={(event) => { setQuantity(Number(event.target.value)); invalidate(); }} /></Field>
                        <Field label="Prefix"><TextInput value={prefix} onChange={(event) => { setPrefix(event.target.value); invalidate(); }} /></Field>
                        <Field label="Start at"><TextInput type="number" min={0} value={start} onChange={(event) => { setStart(Number(event.target.value)); invalidate(); }} /></Field>
                        <Field label="Digits"><TextInput type="number" min={1} max={6} value={pad} onChange={(event) => { setPad(Number(event.target.value)); invalidate(); }} /></Field>
                    </div>
                ) : (
                    <Field label="Codes" hint="One per line, or separated by commas.">
                        <textarea className="h-28 w-full rounded-lg border border-parchment px-3 py-2 text-sm" value={list} onChange={(event) => { setList(event.target.value); invalidate(); }} />
                    </Field>
                )}
                <ErrorNotice error={error} />
                {preview && (
                    <div className="rounded-xl border border-parchment p-4">
                        <p className="mb-3 text-xs font-bold text-ink">
                            {preview.valid ? `${preview.count} ${unit}${preview.count === 1 ? '' : 's'} will be created:` : 'Fix the highlighted codes — nothing will be saved until every code is valid.'}
                        </p>
                        <div className="flex flex-wrap gap-2">
                            {preview.items.map((item, index) => (
                                <span key={`${item.code}-${index}`} title={item.problem ? PROBLEM[item.problem] : 'OK'}
                                    className={`rounded-lg px-2.5 py-1 text-xs font-bold ${item.problem ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'}`}>
                                    {item.code}{item.problem ? ` — ${PROBLEM[item.problem]}` : ''}
                                </span>
                            ))}
                        </div>
                    </div>
                )}
                <div className="flex justify-end gap-2">
                    <Button tone="ghost" onClick={onClose}>Cancel</Button>
                    <Button tone="ghost" onClick={runPreview} busy={busy}>Preview codes</Button>
                    <Button onClick={create} busy={busy} disabled={!preview?.valid}>Create {preview?.valid ? preview.count : ''} {unit}{preview?.count === 1 ? '' : 's'}</Button>
                </div>
            </div>
        </Modal>
    );
}

function ResourceModal({ resource, types, onClose, onSaved }: { resource: Resource; types: ResourceType[]; onClose: () => void; onSaved: () => void }) {
    const { api, business } = useDashboard();
    const type = types.find((item) => item.id === resource.resource_type_id);
    const [code, setCode] = useState(resource.code);
    const [name, setName] = useState(resource.name);
    const [overrides, setOverrides] = useState<Record<string, any>>(resource.overrides);
    const [active, setActive] = useState(resource.is_active);
    const [error, setError] = useState<ApiError | null>(null);
    const [busy, setBusy] = useState(false);
    const readOnly = resource.managed_by === 'external';
    const unit = SERVICE_UNIT[resource.service_type];

    const save = async (acknowledge = false) => {
        setBusy(true); setError(null);
        try {
            const reset = Object.keys(resource.overrides).filter((key) => !(key in overrides));
            await api.updateResource(resource.id, readOnly ? { name } : { code, name, overrides, reset, is_active: active, ...(acknowledge ? { acknowledge_conflicts: true } : {}) });
            onSaved();
        } catch (err) { setError(toApiError(err)); } finally { setBusy(false); }
    };
    const archive = async () => {
        if (!window.confirm(`Remove ${resource.code} from sale? Its booking history is kept.`)) return;
        setBusy(true); setError(null);
        try { await api.archiveResource(resource.id); onSaved(); } catch (err) { setError(toApiError(err)); } finally { setBusy(false); }
    };

    return (
        <Modal wide title={`${unit[0].toUpperCase()}${unit.slice(1)} ${resource.code}`} onClose={onClose}>
            <div className="space-y-4">
                {readOnly && <Notice tone="info">Provider-owned. Only the local display name can be changed; it never overrides the provider's availability or rules.</Notice>}
                <div className="grid gap-4 md:grid-cols-2">
                    <Field label={resource.service_type === 'restaurant' ? 'Table number' : resource.service_type === 'hotel' ? 'Room number' : 'Room code'}>
                        <TextInput value={code} disabled={readOnly} onChange={(event) => setCode(event.target.value)} />
                    </Field>
                    <Field label="Display name (optional)"><TextInput value={name} onChange={(event) => setName(event.target.value)} /></Field>
                </div>
                {type && (
                    <>
                        <p className="text-xs text-ink/60">Values come from the type <strong>{type.name}</strong> unless overridden for this {unit}.</p>
                        <ConfigFields serviceType={resource.service_type} fields={type.fields} value={overrides} onChange={setOverrides}
                            inherited={type.effective.values} inheritedSources={type.effective.sources} level="resource" readOnly={readOnly} currency={business.currency} />
                    </>
                )}
                {!readOnly && (
                    <label className="flex items-center gap-2 text-sm text-ink/80">
                        <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Active — can be booked
                    </label>
                )}
                {resource.legacy && <p className="text-[11px] text-ink/40">Migrated from {resource.legacy.table} #{resource.legacy.id}.</p>}
                <ErrorNotice error={error} />
                <ConflictConfirm error={error} busy={busy} onConfirm={() => save(true)} />
                <div className="flex justify-between">
                    <div>{!readOnly && <Button tone="danger" onClick={archive} busy={busy}>Archive</Button>}</div>
                    <div className="flex gap-2">
                        <Button tone="ghost" onClick={onClose}>Cancel</Button>
                        <Button onClick={() => save()} busy={busy}>Save</Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
