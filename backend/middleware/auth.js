import crypto from 'crypto';
import { verifyAccessToken } from '../services/auth.js';

function getSessionSigningSecret() {
    if (!process.env.SESSION_SIGNING_SECRET) {
        throw new Error('SESSION_SIGNING_SECRET is required. Set it in your environment.');
    }
    return process.env.SESSION_SIGNING_SECRET;
}

function hasSessionSigningSecret() {
    return !!process.env.SESSION_SIGNING_SECRET;
}

function timingSafeEqualString(a, b) {
    const left = Buffer.from(String(a || ''), 'utf8');
    const right = Buffer.from(String(b || ''), 'utf8');
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

const ENABLE_LEGACY_ADMIN_TOKEN_FALLBACK = process.env.ENABLE_LEGACY_ADMIN_TOKEN_FALLBACK !== 'false';
const ALLOW_PUBLIC_ADMIN_ACCESS = process.env.ALLOW_PUBLIC_ADMIN_ACCESS !== 'false' && process.env.NODE_ENV !== 'production';

export function createSessionToken(sessionId) {
    return crypto
        .createHmac('sha256', getSessionSigningSecret())
        .update(String(sessionId))
        .digest('hex');
}

export function verifySessionToken(sessionId, token) {
    if (!sessionId || !token) return false;
    const expected = createSessionToken(sessionId);
    return timingSafeEqualString(expected, token);
}

export function requireSessionToken(req, res, next) {
    if (!hasSessionSigningSecret()) {
        return res.status(503).json({
            error: 'SESSION_SIGNING_SECRET is required for booking sessions.',
        });
    }

    const sessionId = req.params.session_id || req.body.session_id || req.headers['x-session-id'];
    const token = req.headers['x-session-token'] || req.body.session_token;

    if (!verifySessionToken(sessionId, token)) {
        return res.status(401).json({ error: 'Invalid or missing session token.' });
    }

    next();
}

export function requireAdminToken(req, res, next) {
    if (ALLOW_PUBLIC_ADMIN_ACCESS) {
        req.user = req.user || { email: 'admin@local', role: 'admin' };
        return next();
    }

    const configuredToken = process.env.ADMIN_TOKEN;
    const providedToken = req.headers['x-admin-token'];

    // Option 1: legacy static token header
    if (ENABLE_LEGACY_ADMIN_TOKEN_FALLBACK && configuredToken && timingSafeEqualString(configuredToken, providedToken)) {
        return next();
    }

    // Option 2: JWT Bearer with role=admin (also support httpOnly cookie)
    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const cookieToken = req.cookies?.ai_receptionist_auth;
    const token = bearer || cookieToken;
    if (token) {
        try {
            const payload = verifyAccessToken(token);
            if (payload.role === 'admin' || payload.role === 'staff') {
                req.user = payload;
                return next();
            }
        } catch (err) {
            // fallthrough to 401
        }
    }

    return res.status(401).json({ error: 'Invalid or missing admin credentials.' });
}
