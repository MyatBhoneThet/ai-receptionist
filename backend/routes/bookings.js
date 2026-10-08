// Guest-facing reservation access. A guest sees only the reservations made in
// their own session, in the business their session token is bound to.
import express from 'express';
import { bookingsLimiter } from '../middleware/rateLimiter.js';
import { requireSessionToken, resolveGuestBusiness } from '../middleware/auth.js';
import { listReservations } from '../booking/reservations.js';
import { publicBusiness, bookableServices } from '../platform/businesses.js';

const router = express.Router();
router.use(bookingsLimiter);

function guestView(reservation) {
    const { resource, resource_type, correlation_id, review_reason, legacy_review, ...rest } = reservation;
    return {
        ...rest,
        resource_code: resource?.code || null,
        resource_type_name: resource_type?.name || null,
        // Field names the existing summary panel already reads.
        room_number: reservation.service_type === 'hotel' ? resource?.code || null : null,
        table_number: reservation.service_type === 'restaurant' ? resource?.code || null : null,
        room_code: reservation.service_type === 'meeting' ? resource?.code || null : null,
        room_name: reservation.service_type === 'meeting' ? resource?.name || resource_type?.name || null : null,
        room_type: reservation.service_type === 'hotel' ? resource_type?.name || null : null,
    };
}

// GET /api/bookings/public/business?business=slug — what a guest may know about a venue
router.get('/public/business', resolveGuestBusiness, async (req, res, next) => {
    try {
        const { id, name, slug, timezone, currency } = publicBusiness(req.business);
        res.json({ id, name, slug, timezone, currency, services: await bookableServices(req.business) });
    } catch (err) {
        next(err);
    }
});

// GET /api/bookings/:session_id — this session's reservations
router.get('/:session_id', resolveGuestBusiness, requireSessionToken, async (req, res) => {
    try {
        const reservations = await listReservations(req.business.id, { session_id: req.sessionId, limit: 50 });
        res.json(reservations.map(guestView));
    } catch (err) {
        console.error('[GET /api/bookings] Error:', err);
        res.status(500).json({ error: 'Failed to fetch bookings.' });
    }
});

export default router;
