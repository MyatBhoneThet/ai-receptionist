import express from 'express';
import { requireSessionToken, resolveGuestBusiness } from '../middleware/auth.js';
import { sendError } from '../platform/errors.js';
import { checkAvailability, findAlternatives } from '../booking/service.js';
import { toLegacyAvailability } from '../booking/legacyShape.js';

const router = express.Router();

// Guests check availability through the same booking layer as everything else.
router.post('/check', resolveGuestBusiness, requireSessionToken, async (req, res) => {
  try {
    const { session_id, session_token, business, preferred_inventory, exclude_booking_id, ...request } = req.body || {};
    // exclude_booking_id is deliberately not accepted from guests: it would let
    // a caller probe or ignore someone else's reservation.
    const input = { ...request, ...(preferred_inventory ? { preference: preferred_inventory } : {}) };
    const result = await checkAvailability(req.business, input);
    const alternative = result.selected ? null : await findAlternatives(req.business, input).catch(() => null);
    return res.json(toLegacyAvailability(result, alternative));
  } catch (err) {
    return sendError(res, err, 'Failed to check availability');
  }
});

export default router;
