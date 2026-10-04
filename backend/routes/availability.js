import express from 'express';
import { z } from 'zod';
import { checkAvailability } from '../services/availability.js';
import { requireSessionToken } from '../middleware/auth.js';

const router = express.Router();

const bodySchema = z.object({
  service_type: z.enum(['restaurant', 'hotel', 'meeting']),
  date: z.string(),
  end_date: z.string().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  people: z.union([z.number(), z.string()]).optional(),
  preferred_inventory: z.string().optional(),
  exclude_booking_id: z.union([z.number(), z.string()]).optional(),
});

router.post('/check', requireSessionToken, async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const result = await checkAvailability(parsed.data);
    return res.json(result);
  } catch (err) {
    console.error('[POST /api/availability/check]', err);
    return res.status(500).json({ error: 'Failed to check availability' });
  }
});

export default router;
