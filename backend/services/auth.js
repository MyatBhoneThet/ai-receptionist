import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from './db.js';

const TOKEN_TTL = process.env.AUTH_TOKEN_TTL || '1d'; // e.g., "1d", "12h"

function getSigningSecret() {
  if (!process.env.SESSION_SIGNING_SECRET) {
    throw new Error('SESSION_SIGNING_SECRET is required for auth; set it in your environment.');
  }
  return process.env.SESSION_SIGNING_SECRET;
}

export async function createUser({ email, password, name, phone_number, role = 'customer' }) {
  const password_hash = await bcrypt.hash(password, 10);
  const result = await query(
    `INSERT INTO users (email, password_hash, name, phone_number, role)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO NOTHING
     RETURNING id, email, name, phone_number, role, created_at`,
    [email.toLowerCase(), password_hash, name, phone_number, role]
  );
  return result.rows[0] || null;
}

export async function findUserByEmail(email) {
  const result = await query(
    `SELECT id, email, password_hash, name, phone_number, role FROM users WHERE email = $1`,
    [email.toLowerCase()]
  );
  return result.rows[0] || null;
}

export async function verifyPassword(password, password_hash) {
  return bcrypt.compare(password, password_hash);
}

export function signAccessToken(user) {
  const secret = getSigningSecret();
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    secret,
    { expiresIn: TOKEN_TTL }
  );
}

export function verifyAccessToken(token) {
  const secret = getSigningSecret();
  return jwt.verify(token, secret);
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const cookieToken = req.cookies?.ai_receptionist_auth;
  const token = bearer || cookieToken;

  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization token' });
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}
