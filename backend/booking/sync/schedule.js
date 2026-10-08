import { query } from '../../services/db.js';
import { enqueueJob } from './jobs.js';

/** Queue a reconciliation for every connected integration that is due. Catches
 * events a webhook never delivered. */
export async function scheduleReconciliation() {
  const seconds = Math.max(Number(process.env.RECONCILE_INTERVAL_SECONDS) || 300, 30);
  const due = (await query(
    `SELECT id, business_id FROM integrations
     WHERE status = 'connected' AND (last_reconciled_at IS NULL OR last_reconciled_at < NOW() - ($1::int * INTERVAL '1 second'))`, [seconds])).rows;
  for (const integration of due) {
    await enqueueJob(null, { businessId: integration.business_id, integrationId: integration.id, kind: 'reconcile',
      dedupeKey: `integration:${integration.id}` });
  }
  return due.length;
}
