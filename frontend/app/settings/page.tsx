'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchMe, getAuditLogs, getNotificationSettings, saveNotificationSettings, NotificationSettings, AuditLog } from '../../lib/api';

export default function SettingsPage() {
  const [token, setToken] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState('');
  const [settings, setSettings] = useState<NotificationSettings>({
    provider: 'slack',
    webhook_url: '',
    alert_email: '',
  });
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [auditFilter, setAuditFilter] = useState<'all' | 'notification_settings' | 'booking' | 'inventory'>('all');

  useEffect(() => {
    const stored = localStorage.getItem('ai_receptionist_auth_token');
    if (stored) setToken(stored);
  }, []);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const me = await fetchMe(token);
        setUserEmail(me.email);
        const current = await getNotificationSettings(token);
        setSettings(current);
        const audit = await getAuditLogs(token, 8, auditFilter === 'all' ? undefined : auditFilter);
        setLogs(audit);
      } catch (err: any) {
        setError(err?.response?.data?.error || 'Failed to load settings');
      }
    })();
  }, [token, auditFilter]);

  const handleSave = async () => {
    if (!token) return;
    setSaving(true);
    setMessage('');
    try {
      const saved = await saveNotificationSettings(settings, token);
      setSettings(saved);
      setMessage('Notification settings saved.');
      const audit = await getAuditLogs(token, 8, auditFilter === 'all' ? undefined : auditFilter);
      setLogs(audit);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (!token) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-parchment">
        <a href="/login" className="px-4 py-2 rounded-full bg-ink text-white text-xs font-bold uppercase tracking-widest">Admin login required</a>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-white to-parchment">
      <header className="px-10 py-6 border-b border-parchment flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-widest text-ink/50 font-bold">Settings</p>
          <h1 className="text-3xl font-bold text-ink">Notification Setup</h1>
        </div>
        <p className="text-xs text-ink/60">{userEmail}</p>
      </header>

      <section className="max-w-2xl px-10 py-8 space-y-4">
        <SettingField label="Webhook provider" helper="Slack uses blocks; Teams uses MessageCard." >
          <select
            className="w-full rounded-lg border border-parchment px-3 py-2 bg-white"
            value={settings.provider}
            onChange={(e) => setSettings((s) => ({ ...s, provider: e.target.value as 'slack' | 'teams' }))}
          >
            <option value="slack">Slack</option>
            <option value="teams">Teams</option>
          </select>
        </SettingField>

        <SettingField label="Staff webhook URL" helper="Incoming webhook URL for staff alerts.">
          <input
            className="w-full rounded-lg border border-parchment px-3 py-2 bg-white"
            value={settings.webhook_url}
            onChange={(e) => setSettings((s) => ({ ...s, webhook_url: e.target.value }))}
            placeholder="https://hooks.slack.com/..."
          />
        </SettingField>

        <SettingField label="VIP alert email" helper="Optional email target for VIP booking alerts.">
          <input
            className="w-full rounded-lg border border-parchment px-3 py-2 bg-white"
            value={settings.alert_email}
            onChange={(e) => setSettings((s) => ({ ...s, alert_email: e.target.value }))}
            placeholder="staff@hotel.com"
          />
        </SettingField>

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-full bg-ink text-white px-5 py-2 text-xs font-bold uppercase tracking-widest hover:scale-[1.01] disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save settings'}
          </button>
          {message && <span className="text-xs text-emerald-600">{message}</span>}
        </div>

        <div className="rounded-2xl border border-parchment bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-bold text-ink">Recent changes</h2>
            <select
              className="rounded-full border border-parchment px-3 py-1 text-xs text-ink/70 bg-white"
              value={auditFilter}
              onChange={(e) => setAuditFilter(e.target.value as typeof auditFilter)}
            >
              <option value="all">All entities</option>
              <option value="notification_settings">Notification settings</option>
              <option value="booking">Bookings</option>
              <option value="inventory">Inventory</option>
            </select>
          </div>
          <div className="mt-3 space-y-3">
            {logs.map((log) => (
              <div key={log.id} className="rounded-xl border border-parchment p-3">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-sm font-semibold text-ink">{log.entity}</p>
                  <p className="text-[11px] text-ink/50">{new Date(log.created_at).toLocaleString()}</p>
                </div>
                <p className="text-xs text-ink/60 mt-1">
                  {log.action} by {log.actor_email || 'system'}
                </p>
                {log.change_summary && log.change_summary.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {log.change_summary.map((change) => (
                      <p key={change.field} className="text-[11px] text-ink/70">
                        <span className="font-semibold">{change.field}</span>: {String(change.before || '—')} → {String(change.after || '—')}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {logs.length === 0 && <p className="text-sm text-ink/60">No audit entries yet.</p>}
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
      </section>
    </main>
  );
}

function SettingField({ label, helper, children }: { label: string; helper: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[11px] uppercase tracking-widest text-ink/50 font-bold">{label}</span>
        <span className="text-[11px] text-ink/40">{helper}</span>
      </div>
      {children}
    </label>
  );
}
