'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ApiError, Business, BusinessApi, BusinessDetail, businessApi, fetchMe, getAuthToken, listMyBusinesses, logout, toApiError } from '../../lib/api';
import { Badge, Button, ErrorNotice, Loading, Notice } from './ui';

interface DashboardContext {
    api: BusinessApi;
    detail: BusinessDetail;
    business: Business;
    /** Owners and admins manage configuration, integrations and staff access. */
    isManager: boolean;
    reload: () => Promise<void>;
}
const Context = createContext<DashboardContext | null>(null);

export function useDashboard(): DashboardContext {
    const value = useContext(Context);
    if (!value) throw new Error('useDashboard must be used inside <DashboardShell>.');
    return value;
}

const NAV = [
    { href: '/dashboard', label: 'Overview' },
    { href: '/operations', label: 'Operations' },
    { href: '/admin', label: 'Reservations' },
    { href: '/calendar', label: 'Calendar' },
    { href: '/inventory', label: 'Inventory', manager: true },
    { href: '/integrations', label: 'Integrations', manager: true },
    { href: '/settings', label: 'Settings', manager: true },
    { href: '/setup', label: 'Setup', manager: true },
];
const STORAGE_KEY = 'ai_receptionist_business_id';

export default function DashboardShell({ title, eyebrow, children, managerOnly = false }: { title: string; eyebrow: string; children: React.ReactNode; managerOnly?: boolean }) {
    const pathname = usePathname();
    const [phase, setPhase] = useState<'loading' | 'signed_out' | 'no_business' | 'ready' | 'error'>('loading');
    const [email, setEmail] = useState('');
    const [businesses, setBusinesses] = useState<Business[]>([]);
    const [businessId, setBusinessId] = useState<number | null>(null);
    const [detail, setDetail] = useState<BusinessDetail | null>(null);
    const [error, setError] = useState<ApiError | null>(null);

    const loadDetail = useCallback(async (id: number) => {
        setDetail(await businessApi(id).detail());
    }, []);

    useEffect(() => {
        (async () => {
            try {
                const me = await fetchMe(getAuthToken());
                setEmail(me.email);
                const mine = await listMyBusinesses();
                setBusinesses(mine);
                if (!mine.length) { setPhase('no_business'); return; }
                const stored = Number(localStorage.getItem(STORAGE_KEY));
                const chosen = mine.find((item) => item.id === stored) || mine[0];
                setBusinessId(chosen.id);
                await loadDetail(chosen.id);
                setPhase('ready');
            } catch (err) {
                const apiError = toApiError(err);
                if (apiError.status === 401) setPhase('signed_out');
                else { setError(apiError); setPhase('error'); }
            }
        })();
    }, [loadDetail]);

    const switchBusiness = async (id: number) => {
        localStorage.setItem(STORAGE_KEY, String(id));
        setBusinessId(id);
        setDetail(null);
        try { await loadDetail(id); } catch (err) { setError(toApiError(err)); }
    };

    const context = useMemo<DashboardContext | null>(() => {
        if (!detail || !businessId) return null;
        return { api: businessApi(businessId), detail, business: detail.business, isManager: detail.role === 'owner' || detail.role === 'admin',
            reload: () => loadDetail(businessId) };
    }, [detail, businessId, loadDetail]);

    const signOut = async () => {
        await logout().catch(() => undefined);
        localStorage.removeItem('ai_receptionist_auth_token');
        window.location.href = '/login';
    };

    if (phase === 'signed_out') {
        return (
            <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-parchment px-6 text-center">
                <p className="text-sm text-ink/70">Sign in with a staff account to open the business dashboard.</p>
                <a href="/login" className="rounded-full bg-ink px-5 py-3 text-xs font-bold uppercase tracking-widest text-white">Sign in</a>
            </main>
        );
    }

    const status = detail?.business.status;
    return (
        <main className="min-h-screen bg-gradient-to-b from-white to-parchment">
            <header className="border-b border-parchment bg-white/70 px-6 py-4 backdrop-blur lg:px-10">
                <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                        <p className="text-xs font-bold uppercase tracking-widest text-ink/50">{eyebrow}</p>
                        <h1 className="text-2xl font-bold text-ink lg:text-3xl">{title}</h1>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                        {businesses.length > 0 && (
                            <label className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-ink/50">
                                Business
                                <select className="rounded-full border border-parchment bg-white px-3 py-2 text-xs font-bold normal-case tracking-normal text-ink"
                                    value={businessId ?? ''} onChange={(event) => switchBusiness(Number(event.target.value))}>
                                    {businesses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                                </select>
                            </label>
                        )}
                        {status && <Badge tone={status === 'active' ? 'good' : status === 'paused' ? 'warn' : 'info'}>{status === 'active' ? 'Customer booking on' : status === 'paused' ? 'Booking paused' : 'In setup'}</Badge>}
                        {detail && <Badge>{detail.role}</Badge>}
                        <span className="text-xs text-ink/60">{email}</span>
                        <button onClick={signOut} className="text-[11px] font-bold uppercase tracking-widest text-ink/50 underline">Sign out</button>
                    </div>
                </div>
                <nav className="mt-4 flex flex-wrap gap-1" aria-label="Dashboard">
                    {NAV.filter((item) => !item.manager || !detail || context?.isManager).map((item) => (
                        <a key={item.href} href={item.href} aria-current={pathname === item.href ? 'page' : undefined}
                            className={`rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest transition ${pathname === item.href ? 'bg-ink text-white' : 'text-ink/60 hover:bg-parchment'}`}>
                            {item.label}
                        </a>
                    ))}
                    {detail && (
                        <a href={`/?business=${detail.business.slug}`} className="ml-auto rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-gold hover:bg-parchment">
                            Open guest chat ↗
                        </a>
                    )}
                </nav>
            </header>

            <div className="space-y-6 px-6 py-6 lg:px-10">
                {phase === 'loading' && <Loading label="Loading your business" />}
                {phase === 'error' && <ErrorNotice error={error} />}
                {phase === 'no_business' && pathname !== '/setup' && (
                    <Notice tone="info" title="You do not belong to a business yet">
                        <p>Create your business to configure rooms, tables and booking rules.</p>
                        <a href="/setup" className="mt-3 inline-block rounded-full bg-ink px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-white">Start setup</a>
                    </Notice>
                )}
                {phase === 'no_business' && pathname === '/setup' && children}
                {phase === 'ready' && !context && <Loading />}
                {phase === 'ready' && context && managerOnly && !context.isManager && (
                    <Notice tone="warn" title="Owners and admins only">Your role covers reservations and daily operations. Ask an owner for access to configuration.</Notice>
                )}
                {phase === 'ready' && context && (!managerOnly || context.isManager) && (
                    <Context.Provider value={context}>
                        {status === 'setup' && pathname !== '/setup' && context.isManager && (
                            <Notice tone="info" title="Customer booking is not active yet">
                                Finish the <a className="underline" href="/setup">setup checklist</a> to let guests book.
                            </Notice>
                        )}
                        {children}
                    </Context.Provider>
                )}
            </div>
        </main>
    );
}

/** Optional context: lets /setup render before any business exists. */
export function useOptionalDashboard() {
    return useContext(Context);
}

export function useAsync<T>(loader: () => Promise<T>, deps: React.DependencyList) {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<ApiError | null>(null);
    const [loading, setLoading] = useState(true);
    const reload = useCallback(async () => {
        setLoading(true);
        try { setData(await loader()); setError(null); } catch (err) { setError(toApiError(err)); } finally { setLoading(false); }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    useEffect(() => { reload(); }, [reload]);
    return { data, error, loading, reload, setData };
}

export { Button };
