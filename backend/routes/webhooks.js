// Inbound provider webhooks. The signature is verified against the raw body
// with the integration's own secret; the events are then stored as a durable
// job, so an acknowledged delivery is never lost to a crash.
import express from 'express';
import { query } from '../services/db.js';
import { connectorContext } from '../platform/integrations.js';
import { enqueueJob, runJobNow } from '../booking/sync/jobs.js';
import '../booking/service.js';

const router = express.Router();

router.post('/:integrationId', async (req, res) => {
  try {
    const id = Number(req.params.integrationId);
    const integration = Number.isInteger(id) ? (await query('SELECT * FROM integrations WHERE id = $1', [id])).rows[0] : null;
    // Same response for "unknown integration" and "bad signature".
    if (!integration || integration.status === 'disabled') return res.status(401).json({ error: 'Unauthorized' });
    const { connector, ctx } = connectorContext(integration);
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    let events = null;
    try { events = connector.parseWebhook ? connector.parseWebhook(ctx, raw, req.headers) : null; } catch { events = null; }
    if (!events) return res.status(401).json({ error: 'Unauthorized' });
    if (!events.length) return res.json({ received: 0 });
    const jobId = await enqueueJob(null, { businessId: integration.business_id, integrationId: integration.id, kind: 'process_webhook',
      dedupeKey: `webhook:${events.map((event) => event.event_id).join(',').slice(0, 180)}`, payload: { events } });
    const result = await runJobNow(jobId);
    return res.json({ received: events.length, processed: result?.status === 'succeeded' });
  } catch (err) {
    console.error('[webhook]', err.message);
    return res.status(500).json({ error: 'Webhook could not be processed.' });
  }
});

export default router;
