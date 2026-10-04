'use client';

import { useState } from 'react';
import { login, register, logout } from '../../lib/api';

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      if (mode === 'login') {
        const res = await login({ email, password });
        // Token also set as httpOnly cookie; storing is optional for client-only calls.
        localStorage.setItem('ai_receptionist_auth_token', res.token);
        setMessage('Logged in! Cookie set; you can now open the admin dashboard.');
      } else {
        const res = await register({ email, password, name, phone_number: phone });
        localStorage.setItem('ai_receptionist_auth_token', res.token);
        setMessage('Account created. Cookie set; you can now open the admin dashboard.');
      }
    } catch (err: any) {
      setMessage(err?.response?.data?.error || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-parchment to-white">
      <div className="w-full max-w-md rounded-3xl bg-white shadow-2xl border border-parchment p-10 space-y-6">
        <h1 className="text-2xl font-bold text-ink">Admin / Staff Access</h1>
        <p className="text-sm text-ink/60">Sign in to manage bookings, inventory, and analytics.</p>

        <div className="flex space-x-2 text-xs font-bold uppercase tracking-widest">
          {['login', 'register'].map((m) => (
            <button
              key={m}
              onClick={() => setMode(m as 'login' | 'register')}
              className={`flex-1 rounded-full border px-4 py-2 ${
                mode === m ? 'bg-ink text-white' : 'border-ink/10 text-ink/60'
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs uppercase font-bold text-ink/60">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-parchment px-3 py-2"
              required
            />
          </div>
          <div>
            <label className="text-xs uppercase font-bold text-ink/60">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-parchment px-3 py-2"
              required
            />
          </div>
          {mode === 'register' && (
            <>
              <div>
                <label className="text-xs uppercase font-bold text-ink/60">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-parchment px-3 py-2"
                />
              </div>
              <div>
                <label className="text-xs uppercase font-bold text-ink/60">Phone</label>
                <input
                  type="text"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-parchment px-3 py-2"
                />
              </div>
            </>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-full bg-ink text-white py-3 font-bold uppercase tracking-widest hover:scale-[1.01] active:scale-[0.99]"
          >
            {loading ? 'Please wait…' : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        {message && <p className="text-sm text-ink/80">{message}</p>}

        <button
          onClick={async () => { await logout(); localStorage.removeItem('ai_receptionist_auth_token'); setMessage('Signed out'); }}
          className="text-xs uppercase font-bold text-ink underline"
          type="button"
        >
          Sign out (clear cookie)
        </button>
        <p className="text-[11px] text-ink/40">
          Auth now also sets an httpOnly cookie; localStorage fallback remains for dev use only.
        </p>
      </div>
    </main>
  );
}
