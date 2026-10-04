'use client';

import { useEffect, useState } from 'react';
import { fetchMe, savePreferences } from '../../lib/api';

export default function ProfilePage() {
  const [token, setToken] = useState<string | null>(null);
  const [profile, setProfile] = useState<any>(null);
  const [error, setError] = useState<string>('');
  const [form, setForm] = useState({
    dietary: '',
    room_type: '',
    favorite_table: '',
    vip_notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const stored = localStorage.getItem('ai_receptionist_auth_token');
    if (stored) setToken(stored);
  }, []);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const me = await fetchMe(token);
        setProfile(me);
        const prefs = me.preferences || {};
        setForm({
          dietary: prefs.dietary || '',
          room_type: prefs.room_type || '',
          favorite_table: prefs.favorite_table || '',
          vip_notes: prefs.vip_notes || '',
        });
      } catch (err: any) {
        setError(err?.response?.data?.error || 'Failed to load profile');
      }
    })();
  }, [token]);

  const handleSave = async () => {
    if (!token) return;
    setSaving(true);
    setMessage('');
    try {
      const updated = await savePreferences(form, token);
      setProfile(updated);
      setMessage('Preferences saved.');
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to save preferences');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-screen bg-parchment">
      <div className="max-w-3xl mx-auto px-6 py-12 space-y-6">
        <header className="space-y-2">
          <p className="text-xs uppercase tracking-[0.3em] text-ink/50 font-bold">Account</p>
          <h1 className="text-3xl font-bold text-ink">Profile & Preferences</h1>
          <p className="text-sm text-ink/60">Save dietary needs, room type, favorite table, and VIP notes.</p>
        </header>

        {!token && (
          <div className="rounded-2xl border border-parchment bg-white p-6 shadow-sm">
            <p className="text-sm text-ink/70">Please log in first.</p>
            <a href="/login" className="text-xs uppercase font-bold text-ink underline">Go to login</a>
          </div>
        )}

        {token && profile && (
          <div className="rounded-2xl border border-parchment bg-white p-6 shadow-sm space-y-4">
            <div>
              <p className="text-xs uppercase tracking-widest text-ink/50 font-bold">Email</p>
              <p className="text-sm text-ink">{profile.email}</p>
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              <PreferenceField
                label="Dietary"
                value={form.dietary}
                onChange={(v) => setForm((f) => ({ ...f, dietary: v }))}
                placeholder="e.g., vegetarian, no nuts"
              />
              <PreferenceField
                label="Room type"
                value={form.room_type}
                onChange={(v) => setForm((f) => ({ ...f, room_type: v }))}
                placeholder="King, high floor, quiet side"
              />
              <PreferenceField
                label="Favorite table"
                value={form.favorite_table}
                onChange={(v) => setForm((f) => ({ ...f, favorite_table: v }))}
                placeholder="By the window, booth"
              />
              <PreferenceField
                label="VIP notes"
                value={form.vip_notes}
                onChange={(v) => setForm((f) => ({ ...f, vip_notes: v }))}
                placeholder="Birthday on 20th, likes Rioja"
              />
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleSave}
                disabled={saving}
                className="rounded-full bg-ink text-white px-5 py-2 text-xs font-bold uppercase tracking-widest hover:scale-[1.01] disabled:opacity-60"
              >
                {saving ? 'Saving…' : 'Save preferences'}
              </button>
              {message && <span className="text-xs text-emerald-600">{message}</span>}
            </div>
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </main>
  );
}

function PreferenceField({ label, placeholder, value, onChange }: { label: string; placeholder: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] uppercase tracking-widest text-ink/50 font-bold">{label}</p>
      <input
        className="w-full rounded-lg border border-parchment px-3 py-2 bg-white"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
