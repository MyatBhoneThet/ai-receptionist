'use client';

import React from 'react';
import type { ConfigSource, FieldInfo, ServiceType } from '../../lib/api';
import { inputClass } from './ui';

type Kind = 'number' | 'text' | 'time' | 'money' | 'tags' | 'rate_unit' | 'layouts' | 'deposit' | 'hours';
const KIND: Record<string, Kind> = {
    max_guests: 'number', min_stay_nights: 'number', seating_capacity: 'number', default_duration_minutes: 'number',
    turnover_buffer_minutes: 'number', min_duration_minutes: 'number', increment_minutes: 'number', setup_buffer_minutes: 'number',
    cleanup_buffer_minutes: 'number', floor: 'number', bed_configuration: 'text', seating_area: 'text',
    check_in_time: 'time', check_out_time: 'time', base_rate: 'money', min_spend: 'money', booking_fee: 'money',
    amenities: 'tags', equipment: 'tags', rate_unit: 'rate_unit', layouts: 'layouts', deposit: 'deposit', operating_hours: 'hours',
};
const DAYS: [string, string][] = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
const SOURCE_LABEL: Record<ConfigSource, string> = { platform: 'platform default', service: 'service default', type: 'type default', resource: 'this item' };
const HINTS: Record<string, string> = {
    min_spend: 'A spending commitment for the table. Not a charge, and separate from any deposit or fee.',
    deposit: 'Disclosed to the guest. Staff record when it is paid — no online payment is taken.',
    booking_fee: 'A charge added to the reservation total. Separate from deposit and minimum spend.',
    operating_hours: 'A closing time earlier than the opening time runs past midnight. Leave a day empty for closed.',
    turnover_buffer_minutes: 'Time blocked after each sitting for clearing and resetting.',
    setup_buffer_minutes: 'Time blocked before each meeting.',
    cleanup_buffer_minutes: 'Time blocked after each meeting.',
    check_out_time: 'A new stay can begin on the checkout date from check-in time.',
};

export function describeValue(key: string, value: any, currency?: string | null): string {
    if (value === null || value === undefined || value === '') return key === 'operating_hours' ? 'Open all day' : '—';
    const kind = KIND[key];
    if (kind === 'money') return `${value}${currency ? ` ${currency}` : ''}`;
    if (kind === 'tags') return (value as string[]).length ? (value as string[]).join(', ') : 'None';
    if (kind === 'layouts') return (value as { name: string; capacity: number }[]).map((item) => `${item.name}: ${item.capacity}`).join(' · ');
    if (kind === 'deposit') {
        if (value.type === 'none') return 'No deposit';
        if (value.type === 'percent') return `${value.percent}% of the total`;
        return `${value.amount}${currency ? ` ${currency}` : ''}${value.type === 'per_guest' ? ' per guest' : ''}`;
    }
    if (kind === 'hours') {
        return DAYS.map(([day, label]) => `${label} ${(value[day] || []).map((p: any) => `${p.open}–${p.close}`).join(', ') || 'closed'}`).join(' · ');
    }
    if (kind === 'rate_unit') return value === 'daily' ? 'Per day' : 'Per hour';
    return String(value);
}

function parseHours(text: string) {
    return text.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
        const [open, close] = part.split(/[–-]/).map((piece) => piece.trim());
        return { open, close };
    });
}

function Editor({ fieldKey, value, onChange, disabled }: { fieldKey: string; value: any; onChange: (value: any) => void; disabled: boolean }) {
    const kind = KIND[fieldKey] || 'text';
    if (kind === 'number') {
        return <input type="number" className={inputClass} disabled={disabled} value={value ?? ''}
            onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))} />;
    }
    if (kind === 'time') return <input type="time" className={inputClass} disabled={disabled} value={value ?? ''} onChange={(event) => onChange(event.target.value)} />;
    if (kind === 'money') {
        return <input inputMode="decimal" className={inputClass} disabled={disabled} value={value ?? ''} placeholder="0.00"
            onChange={(event) => onChange(event.target.value.trim())} />;
    }
    if (kind === 'tags') {
        return <input className={inputClass} disabled={disabled} value={(value || []).join(', ')} placeholder="Comma separated"
            onChange={(event) => onChange(event.target.value.split(',').map((item) => item.trim()).filter(Boolean))} />;
    }
    if (kind === 'rate_unit') {
        return (
            <select className={inputClass} disabled={disabled} value={value || 'hourly'} onChange={(event) => onChange(event.target.value)}>
                <option value="hourly">Per hour</option>
                <option value="daily">Per day</option>
            </select>
        );
    }
    if (kind === 'layouts') {
        const rows: { name: string; capacity: number }[] = value || [];
        return (
            <div className="space-y-2">
                {rows.map((row, index) => (
                    <div key={index} className="flex gap-2">
                        <input className={inputClass} disabled={disabled} value={row.name} placeholder="Layout (e.g. Theatre)" aria-label="Layout name"
                            onChange={(event) => onChange(rows.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)))} />
                        <input type="number" className={`${inputClass} max-w-[7rem]`} disabled={disabled} value={row.capacity} aria-label="Capacity for this layout"
                            onChange={(event) => onChange(rows.map((item, i) => (i === index ? { ...item, capacity: Number(event.target.value) } : item)))} />
                        {!disabled && rows.length > 1 && (
                            <button type="button" className="text-xs font-bold text-rose-700" onClick={() => onChange(rows.filter((_, i) => i !== index))}>Remove</button>
                        )}
                    </div>
                ))}
                {!disabled && <button type="button" className="text-[11px] font-bold uppercase tracking-widest text-ink/60 underline"
                    onClick={() => onChange([...rows, { name: '', capacity: 1 }])}>Add layout</button>}
            </div>
        );
    }
    if (kind === 'deposit') {
        const rule = value || { type: 'none' };
        return (
            <div className="flex gap-2">
                <select className={inputClass} disabled={disabled} value={rule.type}
                    onChange={(event) => onChange(event.target.value === 'none' ? { type: 'none' }
                        : event.target.value === 'percent' ? { type: 'percent', percent: 10 } : { type: event.target.value, amount: rule.amount || '0' })}>
                    <option value="none">No deposit</option>
                    <option value="fixed">Fixed amount</option>
                    <option value="per_guest">Amount per guest</option>
                    <option value="percent">Percent of total</option>
                </select>
                {rule.type === 'percent' && <input type="number" className={`${inputClass} max-w-[7rem]`} disabled={disabled} value={rule.percent} aria-label="Deposit percent"
                    onChange={(event) => onChange({ type: 'percent', percent: Number(event.target.value) })} />}
                {(rule.type === 'fixed' || rule.type === 'per_guest') && <input inputMode="decimal" className={`${inputClass} max-w-[9rem]`} disabled={disabled} value={rule.amount} aria-label="Deposit amount"
                    onChange={(event) => onChange({ type: rule.type, amount: event.target.value.trim() })} />}
            </div>
        );
    }
    if (kind === 'hours') {
        const hours = value || null;
        return (
            <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs text-ink/70">
                    <input type="checkbox" disabled={disabled} checked={hours === null} onChange={(event) => onChange(event.target.checked ? null : Object.fromEntries(DAYS.map(([day]) => [day, [{ open: '09:00', close: '17:00' }]])))} />
                    Open all day, every day
                </label>
                {hours && DAYS.map(([day, label]) => (
                    <div key={day} className="flex items-center gap-2">
                        <span className="w-10 text-xs font-bold text-ink/60">{label}</span>
                        <HoursInput disabled={disabled} periods={hours[day] || []} onCommit={(periods) => onChange({ ...hours, [day]: periods })} />
                    </div>
                ))}
            </div>
        );
    }
    return <input className={inputClass} disabled={disabled} value={value ?? ''} onChange={(event) => onChange(event.target.value)} />;
}

function HoursInput({ periods, onCommit, disabled }: { periods: { open: string; close: string }[]; onCommit: (periods: { open: string; close: string }[]) => void; disabled: boolean }) {
    const format = (list: { open: string; close: string }[]) => list.map((period) => `${period.open}-${period.close}`).join(', ');
    const [text, setText] = React.useState(format(periods));
    React.useEffect(() => { setText(format(periods)); }, [JSON.stringify(periods)]); // eslint-disable-line react-hooks/exhaustive-deps
    return <input className={inputClass} disabled={disabled} value={text} placeholder="closed — or e.g. 11:00-14:30, 18:00-02:00"
        onChange={(event) => setText(event.target.value)} onBlur={() => onCommit(parseHours(text))} />;
}

/**
 * Edits ONE level of configuration. Fields not set at this level show the
 * inherited value and where it comes from; "Reset to default" removes this
 * level's value so the item inherits again.
 */
export default function ConfigFields({ fields, value, onChange, inherited, inheritedSources, level, readOnly = false, currency, only }: {
    serviceType: ServiceType; fields: FieldInfo[]; value: Record<string, any>; onChange: (next: Record<string, any>) => void;
    inherited: Record<string, any>; inheritedSources?: Record<string, ConfigSource>; level: ConfigSource; readOnly?: boolean;
    currency?: string | null; only?: string[];
}) {
    const shown = only ? fields.filter((field) => only.includes(field.key)) : fields;
    return (
        <div className="grid gap-4 md:grid-cols-2">
            {shown.map((field) => {
                const setHere = Object.prototype.hasOwnProperty.call(value, field.key);
                const from = inheritedSources?.[field.key] || (level === 'service' ? 'platform' : level === 'type' ? 'service' : 'type');
                const wide = ['layouts', 'operating_hours', 'deposit'].includes(field.key);
                return (
                    <div key={field.key} className={`rounded-xl border p-3 ${setHere ? 'border-ink/20 bg-white' : 'border-parchment bg-parchment/40'} ${wide ? 'md:col-span-2' : ''}`}>
                        <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="text-[11px] font-bold uppercase tracking-widest text-ink/60">{field.label}</span>
                            {setHere ? (
                                <span className="flex items-center gap-2">
                                    <span className="text-[10px] font-bold uppercase tracking-widest text-gold">Set here</span>
                                    {!readOnly && (
                                        <button type="button" className="text-[10px] font-bold uppercase tracking-widest text-ink/50 underline"
                                            onClick={() => { const next = { ...value }; delete next[field.key]; onChange(next); }}>
                                            Reset to default
                                        </button>
                                    )}
                                </span>
                            ) : (
                                <span className="text-[10px] font-bold uppercase tracking-widest text-ink/40">Inherited · {SOURCE_LABEL[from]}</span>
                            )}
                        </div>
                        {setHere ? (
                            <Editor fieldKey={field.key} value={value[field.key]} disabled={readOnly} onChange={(next) => onChange({ ...value, [field.key]: next })} />
                        ) : (
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-sm text-ink/70">{describeValue(field.key, inherited[field.key], currency)}</span>
                                {!readOnly && (
                                    <button type="button" className="shrink-0 rounded-full border border-ink/15 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-ink/60 hover:bg-white"
                                        onClick={() => onChange({ ...value, [field.key]: inherited[field.key] ?? (KIND[field.key] === 'tags' ? [] : '') })}>
                                        {level === 'service' ? 'Change' : 'Override'}
                                    </button>
                                )}
                            </div>
                        )}
                        {HINTS[field.key] && <p className="mt-2 text-[11px] text-ink/50">{HINTS[field.key]}</p>}
                    </div>
                );
            })}
        </div>
    );
}
