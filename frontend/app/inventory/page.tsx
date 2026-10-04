'use client';

import { useEffect, useState } from 'react';
import { fetchMe, listInventory, upsertInventory } from '../../lib/api';

export default function InventoryPage() {
  const [token, setToken] = useState<string | null>(null);
  const [items, setItems] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    category: 'room',
    code: '',
    name: '',
    capacity: 0,
    quantity: 1,
  });
  const [userEmail, setUserEmail] = useState('');

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
        const inv = await listInventory(token);
        setItems(inv);
      } catch (err: any) {
        setError(err?.response?.data?.error || 'Failed to load inventory');
      }
    })();
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setError('');
    try {
      const saved = await upsertInventory({
        category: form.category as any,
        code: form.code,
        name: form.name,
        capacity: Number(form.capacity),
        quantity: Number(form.quantity),
      }, token);
      setItems((prev) => {
        const idx = prev.findIndex((i) => i.id === saved.id);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = saved;
          return copy;
        }
        return [...prev, saved];
      });
      setForm({ category: 'room', code: '', name: '', capacity: 0, quantity: 1 });
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Save failed');
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
      <header className="px-10 py-6 flex items-center justify-between border-b border-parchment">
        <div>
          <p className="text-xs uppercase font-bold tracking-widest text-ink/50">Inventory</p>
          <h1 className="text-3xl font-bold text-ink">Rooms / Tables / Meetings</h1>
        </div>
        <p className="text-xs text-ink/60">{userEmail}</p>
      </header>

      <section className="px-10 py-6 grid gap-6 md:grid-cols-3">
        <div className="rounded-2xl border border-parchment bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-ink mb-3">Add / Update</h2>
          <form className="space-y-3" onSubmit={handleSubmit}>
            <Select label="Category" value={form.category} onChange={(v) => setForm((f) => ({ ...f, category: v }))} />
            <Input label="Code" value={form.code} onChange={(v) => setForm((f) => ({ ...f, code: v }))} required />
            <Input label="Name" value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} />
            <Input label="Capacity" type="number" value={form.capacity} onChange={(v) => setForm((f) => ({ ...f, capacity: Number(v) }))} />
            <Input label="Quantity" type="number" value={form.quantity} onChange={(v) => setForm((f) => ({ ...f, quantity: Number(v) }))} />
            <button className="w-full rounded-full bg-ink text-white py-3 text-xs font-bold uppercase tracking-widest hover:scale-[1.01]">
              Save item
            </button>
          </form>
          {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
        </div>

        <div className="md:col-span-2 rounded-2xl border border-parchment bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-ink mb-3">Inventory list</h2>
          <div className="grid md:grid-cols-2 gap-3">
            {items.map((item) => (
              <div key={item.id} className="rounded-xl border border-parchment p-4">
                <p className="text-xs uppercase tracking-widest text-ink/50 font-bold">{item.category} · {item.code}</p>
                <p className="text-lg font-bold text-ink">{item.name || '—'}</p>
                <p className="text-xs text-ink/60">Capacity {item.capacity} · Qty {item.quantity}</p>
              </div>
            ))}
            {items.length === 0 && <p className="text-sm text-ink/60">No items yet.</p>}
          </div>
        </div>
      </section>
    </main>
  );
}

function Input({ label, value, onChange, type = 'text', required = false }: { label: string; value: any; onChange: (v: string) => void; type?: string; required?: boolean }) {
  return (
    <label className="block space-y-1 text-sm text-ink">
      <span className="text-[11px] uppercase tracking-widest text-ink/50 font-bold">{label}</span>
      <input
        className="w-full rounded-lg border border-parchment px-3 py-2"
        value={value}
        type={type}
        required={required}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function Select({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block space-y-1 text-sm text-ink">
      <span className="text-[11px] uppercase tracking-widest text-ink/50 font-bold">{label}</span>
      <select
        className="w-full rounded-lg border border-parchment px-3 py-2 bg-white"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="room">Room</option>
        <option value="table">Table</option>
        <option value="meeting">Meeting</option>
      </select>
    </label>
  );
}
