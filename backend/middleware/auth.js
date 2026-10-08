import crypto from 'crypto';
import { verifyAccessToken } from '../services/auth.js';
import { query } from '../services/db.js';
import { resolvePublicBusiness } from '../platform/businesses.js';

function getSessionSigningSecret() {
    if (!process.env.SESSION_SIGNING_SECRET) {
        throw new Error('SESSION_SIGNING_SECRET is required. Set it in your environment.');
    }
    return process.env.SESSION_SIGNING_SECRET;
}

function timingSafeEqualString(a, b) {
    const left = Buffer.from(String(a || ''), 'utf8');
    const right = Buffer.from(String(b || ''), 'utf8');
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

// A guest session token is bound to ONE business. The same session ID
// presented to another business produces a different token and is rejected.
export function createSessionToken(businessId, sessionId) {
    return crypto
        .createHmac('sha256', getSessionSigningSecret())
        .update(`v2:${businessId}:${sessionId}`)
        .digest('hex');
}

export function verifySessionToken(businessId, sessionId, token) {
    if (!businessId || !sessionId || !token) return false;
    return timingSafeEqualString(createSessionToken(businessId, sessionId), token);
}

export function requestedBusinessSlug(req) {
    return req.body?.business || req.query?.business || req.headers['x-business'] || '';
}

/** Resolve the business a guest request addresses (by public identifier). */
export async function resolveGuestBusiness(req, res, next) {
    try {
        const business = await resolvePublicBusiness(requestedBusinessSlug(req));
        if (!business) return res.status(404).json({ error: 'Business not found. Use the booking link provided by the venue.' });
        req.business = business;
        return next();
    } catch (err) {
        return next(err);
    }
}

export function requireSessionToken(req, res, next) {
    if (!process.env.SESSION_SIGNING_SECRET) {
        return res.status(503).json({ error: 'SESSION_SIGNING_SECRET is required for booking sessions.' });
    }
    const sessionId = req.params.session_id || req.body?.session_id || req.headers['x-session-id'];
    const token = req.headers['x-session-token'] || req.body?.session_token;
    if (!req.business || !verifySessionToken(req.business.id, sessionId, token)) {
        return res.status(401).json({ error: 'Invalid or missing session token.' });
    }
    req.sessionId = String(sessionId);
    return next();
}

/** Staff identity comes only from a signed login token (header or httpOnly cookie). */
export function authenticate(req, res, next) {
    const header = req.headers.authorization || '';
    const token = (header.startsWith('Bearer ') ? header.slice(7) : null) || req.cookies?.ai_receptionist_auth;
    if (!token) return res.status(401).json({ error: 'Sign in required.' });
    try {
        const payload = verifyAccessToken(token);
        req.user = { id: Number(payload.sub), email: payload.email };
        if (!Number.isInteger(req.user.id)) throw new Error('bad subject');
        return next();
    } catch {
        return res.status(401).json({ error: 'Invalid or expired token.' });
    }
}

/**
 * Authorize a business route. Membership is looked up on the server for the
 * signed-in user; a business ID in the URL or body grants nothing by itself.
 * Non-members get 404 so the existence of other businesses is not revealed.
 */
export function requireBusinessRole(...roles) {
    return async (req, res, next) => {
        try {
            const businessId = Number(req.params.businessId);
            if (!Number.isInteger(businessId) || businessId < 1) return res.status(404).json({ error: 'Business not found.' });
            const result = await query(
                `SELECT b.*, m.role AS membership_role FROM businesses b
                 JOIN business_memberships m ON m.business_id = b.id
                 WHERE b.id = $1 AND m.user_id = $2`, [businessId, req.user.id]);
            const row = result.rows[0];
            if (!row) return res.status(404).json({ error: 'Business not found.' });
            if (roles.length && !roles.includes(row.membership_role)) {
                return res.status(403).json({ error: 'Your role does not allow this action.' });
            }
            const { membership_role, ...business } = row;
            req.business = business;
            req.membershipRole = membership_role;
            req.actor = { email: req.user.email, userId: req.user.id };
            return next();
        } catch (err) {
            return next(err);
        }
    };
}

export const MANAGER_ROLES = ['owner', 'admin'];
