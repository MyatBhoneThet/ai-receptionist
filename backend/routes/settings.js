import express from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../middleware/auth.js';
import { getNotificationSettings, listRecentAuditLogs, upsertNotificationSettings } from '../services/appSettings.js';

const router = express.Router();
router.use(requireAdminToken);

const notificationSchema = z.object({
  provider: z.enum(['slack', 'teams']),
  webhook_url: z.string().url().or(z.literal('')),
  alert_email: z.string().email().or(z.literal('')),
});

router.get('/notifications', async (_req, res) => {
  try {
    const settings = await getNotificationSettings();
    res.json(settings);
  } catch (err) {
    console.error('[GET /api/settings/notifications]', err);
    res.status(500).json({ error: 'Failed to load notification settings' });
  }
});

router.patch('/notifications', async (req, res) => {
  const parsed = notificationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const actorEmail = req.user?.email || 'admin';
    const settings = await upsertNotificationSettings(parsed.data, actorEmail);
    res.json(settings);
  } catch (err) {
    console.error('[PATCH /api/settings/notifications]', err);
    res.status(500).json({ error: 'Failed to save notification settings' });
  }
});

router.get('/audit', async (req, res) => {
  try {
    const logs = await listRecentAuditLogs(req.query.limit || 20, req.query.entity || '');
    res.json(logs);
  } catch (err) {
    console.error('[GET /api/settings/audit]', err);
    res.status(500).json({ error: 'Failed to load audit logs' });
  }
});

export default router;
