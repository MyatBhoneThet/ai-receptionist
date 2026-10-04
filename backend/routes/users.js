import express from 'express';
import { z } from 'zod';
import { createUser, findUserByEmail, verifyPassword, signAccessToken, requireAuth } from '../services/auth.js';
import { query } from '../services/db.js';
import { authLimiter } from '../middleware/rateLimiter.js';

function setAuthCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('ai_receptionist_auth', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: 1000 * 60 * 60 * 24, // 1 day
  });
}

const router = express.Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).optional(),
  phone_number: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { email, password, name, phone_number } = parsed.data;
  try {
    const existing = await findUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const user = await createUser({ email, password, name, phone_number });
    if (!user) {
      return res.status(500).json({ error: 'Failed to create user' });
    }

    const token = signAccessToken(user);
    setAuthCookie(res, token);
    return res.json({ token, user });
  } catch (err) {
    console.error('[POST /api/users/register]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { email, password } = parsed.data;
  try {
    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signAccessToken(user);
    const { password_hash, ...safeUser } = user;
    setAuthCookie(res, token);
    return res.json({ token, user: safeUser });
  } catch (err) {
    console.error('[POST /api/users/login]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
    try {
        const user = await findUserByEmail(req.user.email);
        if (!user) return res.status(404).json({ error: 'User not found' });
        const { password_hash, ...safeUser } = user;
        return res.json(safeUser);
    } catch (err) {
        console.error('[GET /api/users/me]', err);
        return res.status(500).json({ error: 'Server error' });
    }
});

const preferencesSchema = z.object({
  dietary: z.string().max(200).optional(),
  room_type: z.string().max(200).optional(),
  favorite_table: z.string().max(200).optional(),
  vip_notes: z.string().max(500).optional(),
});

router.patch('/me/preferences', requireAuth, async (req, res) => {
  const parsed = preferencesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const result = await query(
      `UPDATE users SET preferences = COALESCE(preferences, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
       WHERE email = $2 RETURNING id, email, name, phone_number, role, preferences`,
      [JSON.stringify(parsed.data), req.user.email]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('[PATCH /api/users/me/preferences]', err);
    return res.status(500).json({ error: 'Failed to save preferences' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('ai_receptionist_auth');
  return res.json({ success: true });
});

export default router;
