'use client';

import React from 'react';
import type { ApiError, BookingSource } from '../../lib/api';

export function Card({ title, hint, action, children, className = '' }: { title?: string; hint?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
    return (
        <section className={`rounded-2xl border border-parchment bg-white p-6 shadow-sm ${className}`}>
            {(title || action) && (
                <div className="mb-4 flex items-start justify-between gap-4">
                    <div>
                        {title && <h2 className="text-lg font-bold text-ink">{title}</h2>}
                        {hint && <p className="mt-1 text-xs text-ink/60">{hint}</p>}
                    </div>
                    {action}
                </div>
            )}
            {children}
        </section>
    );
}

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';
const TONES: Record<Tone, string> = {
    neutral: 'bg-parchment text-ink/70', good: 'bg-emerald-50 text-emerald-700', warn: 'bg-amber-50 text-amber-800',
    bad: 'bg-rose-50 text-rose-700', info: 'bg-sky-50 text-sky-700',
};
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
    return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest ${TONES[tone]}`}>{children}</span>;
}

/** Shows which system is the authoritative booking record. */
export function SourceBadge({ source, mock, name }: { source: BookingSource; mock?: boolean; name?: string }) {
    if (source === 'internal') return <Badge tone="neutral">Source: this dashboard</Badge>;
    return <Badge tone={mock ? 'warn' : 'info'}>Source: {name || 'external system'}{mock ? ' · MOCK' : ''}</Badge>;
}

export function Button({ tone = 'primary', busy, children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'ghost' | 'danger' | 'gold'; busy?: boolean }) {
    const tones = {
        primary: 'bg-ink text-white hover:bg-ink/90', ghost: 'border border-ink/15 text-ink/70 hover:bg-parchment',
        danger: 'border border-rose-200 text-rose-700 hover:bg-rose-50', gold: 'bg-gold text-ink hover:brightness-95',
    };
    return (
        <button {...props} disabled={props.disabled || busy}
            className={`rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-widest transition disabled:cursor-not-allowed disabled:opacity-50 ${tones[tone]} ${className}`}>
            {busy ? 'Working…' : children}
        </button>
    );
}

export function Field({ label, hint, children, error }: { label: string; hint?: React.ReactNode; children: React.ReactNode; error?: string }) {
    return (
        <label className="block space-y-1 text-sm text-ink">
            <span className="text-[11px] font-bold uppercase tracking-widest text-ink/50">{label}</span>
            {children}
            {hint && <span className="block text-[11px] text-ink/50">{hint}</span>}
            {error && <span className="block text-[11px] font-medium text-rose-700" role="alert">{error}</span>}
        </label>
    );
}

export const inputClass = 'w-full rounded-lg border border-parchment bg-white px-3 py-2 text-sm text-ink placeholder:text-ink/30 focus:border-ink/40 focus:outline-none disabled:bg-parchment/60 disabled:text-ink/50';

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
    return <input {...props} className={`${inputClass} ${props.className || ''}`} />;
}
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
    return <select {...props} className={`${inputClass} ${props.className || ''}`} />;
}

export function Notice({ tone = 'info', title, children, onDismiss }: { tone?: Tone; title?: string; children?: React.ReactNode; onDismiss?: () => void }) {
    const tones: Record<Tone, string> = {
        neutral: 'border-parchment bg-white text-ink/70', good: 'border-emerald-200 bg-emerald-50 text-emerald-900',
        warn: 'border-amber-200 bg-amber-50 text-amber-900', bad: 'border-rose-200 bg-rose-50 text-rose-900', info: 'border-sky-200 bg-sky-50 text-sky-900',
    };
    return (
        <div role={tone === 'bad' ? 'alert' : 'status'} className={`flex items-start justify-between gap-4 rounded-xl border px-4 py-3 text-sm ${tones[tone]}`}>
            <div>
                {title && <p className="font-bold">{title}</p>}
                {children && <div className={title ? 'mt-1' : ''}>{children}</div>}
            </div>
            {onDismiss && <button onClick={onDismiss} className="text-xs font-bold uppercase tracking-widest opacity-60 hover:opacity-100" aria-label="Dismiss">Close</button>}
        </div>
    );
}

const ERROR_TITLES: Record<string, string> = {
    conflict: 'Not available', quote_changed: 'Price or terms changed', not_ready: 'Not ready yet',
    unsupported_operation: 'Not possible from this dashboard', provider_unavailable: 'Reservation system unavailable',
    provider_error: 'Reservation system error', config_conflict: 'This affects existing reservations',
    activation_blocked: 'Cannot activate yet', validation: 'Please check the details', forbidden: 'Not allowed for your role',
    idempotency_conflict: 'Duplicate request', network: 'Connection problem',
};

/** A structured backend error, explained in the terms the user needs. */
export function ErrorNotice({ error, onDismiss }: { error: ApiError | null; onDismiss?: () => void }) {
    if (!error) return null;
    const issues = error.details?.issues as { path: (string | number)[]; message: string }[] | undefined;
    const affected = error.details?.affected_bookings as { booking_id: number; reason: string; reservation_name?: string }[] | undefined;
    return (
        <Notice tone={error.code === 'conflict' || error.code === 'quote_changed' || error.code === 'not_ready' || error.code === 'config_conflict' ? 'warn' : 'bad'}
            title={ERROR_TITLES[error.code] || 'Something went wrong'} onDismiss={onDismiss}>
            <p>{error.message}</p>
            {issues && <ul className="mt-2 list-disc pl-5 text-xs">{issues.slice(0, 6).map((issue, index) => <li key={index}>{issue.path.join(' › ') || 'request'}: {issue.message}</li>)}</ul>}
            {affected && (
                <ul className="mt-2 list-disc pl-5 text-xs">
                    {affected.slice(0, 8).map((item) => <li key={`${item.booking_id}-${item.reason}`}>Reservation #{item.booking_id}{item.reservation_name ? ` (${item.reservation_name})` : ''}: {item.reason.replace(/_/g, ' ')}</li>)}
                </ul>
            )}
        </Notice>
    );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
    return (
        <div className="rounded-xl border border-dashed border-ink/15 px-6 py-10 text-center">
            <p className="text-sm font-bold text-ink">{title}</p>
            {children && <div className="mt-2 text-xs text-ink/60">{children}</div>}
        </div>
    );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
    return (
        <div className="space-y-3" aria-busy="true" aria-label={label}>
            {[0, 1, 2].map((row) => <div key={row} className="h-16 animate-pulse rounded-2xl border border-parchment bg-white" />)}
        </div>
    );
}

export function Tabs<T extends string>({ value, onChange, options }: { value: T; onChange: (value: T) => void; options: { value: T; label: string; count?: number }[] }) {
    return (
        <div className="flex flex-wrap gap-2" role="tablist">
            {options.map((option) => (
                <button key={option.value} role="tab" aria-selected={value === option.value} onClick={() => onChange(option.value)}
                    className={`rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-widest transition ${value === option.value ? 'bg-ink text-white' : 'border border-ink/10 text-ink/60 hover:bg-white'}`}>
                    {option.label}{option.count !== undefined ? ` · ${option.count}` : ''}
                </button>
            ))}
        </div>
    );
}

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
    React.useEffect(() => {
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 backdrop-blur-sm sm:p-10" role="dialog" aria-modal="true" aria-label={title}>
            <div className={`w-full ${wide ? 'max-w-3xl' : 'max-w-xl'} rounded-2xl border border-parchment bg-white p-6 shadow-2xl`}>
                <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-lg font-bold text-ink">{title}</h2>
                    <button onClick={onClose} className="text-xs font-bold uppercase tracking-widest text-ink/50 hover:text-ink">Close</button>
                </div>
                {children}
            </div>
        </div>
    );
}
