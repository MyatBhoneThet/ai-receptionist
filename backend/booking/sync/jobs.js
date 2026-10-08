// Durable background jobs (PostgreSQL-backed). Jobs survive process restarts,
// are claimed with SKIP LOCKED, retried with exponential backoff, and at most
// one live job exists per (business, kind, dedupe_key).
import { query } from '../../services/db.js';

const handlers = new Map();
const STALE_AFTER_MINUTES = 5;

export function registerJobHandler(kind, handler) {
  handlers.set(kind, handler);
}

export async function enqueueJob(db, { businessId, integrationId = null, kind, dedupeKey, payload = {}, delayMs = 0, maxAttempts = 8 }) {
  const run = db ? db.query.bind(db) : query;
  const row = (await run(
    `INSERT INTO sync_jobs (business_id, integration_id, kind, dedupe_key, payload, run_after, max_attempts)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW() + ($6::int * INTERVAL '1 millisecond'), $7)
     ON CONFLICT (business_id, kind, dedupe_key) WHERE status IN ('queued', 'running')
     DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
     RETURNING id`, [businessId, integrationId, kind, String(dedupeKey), JSON.stringify(payload), delayMs, maxAttempts])).rows[0];
  return Number(row.id);
}

function backoffMs(attempts, err) {
  if (err?.retryAfterMs) return err.retryAfterMs;
  return Math.min(2 ** attempts * 15000, 60 * 60 * 1000);
}

async function execute(job) {
  const handler = handlers.get(job.kind);
  try {
    if (!handler) throw new Error(`No handler is registered for job kind "${job.kind}".`);
    const outcome = await handler(job);
    if (outcome?.retry) throw Object.assign(new Error(outcome.error || 'Retry requested.'), { retryAfterMs: outcome.retryAfterMs });
    await query(`UPDATE sync_jobs SET status = 'succeeded', finished_at = NOW(), last_error = NULL, locked_at = NULL WHERE id = $1`, [job.id]);
    return { id: Number(job.id), status: 'succeeded', outcome };
  } catch (err) {
    const dead = job.attempts >= job.max_attempts;
    // Error text only — never payloads or credentials.
    const message = String(err?.message || err).slice(0, 500);
    await query(
      `UPDATE sync_jobs SET status = $2, last_error = $3, locked_at = NULL,
              run_after = NOW() + ($4::bigint * INTERVAL '1 millisecond'), finished_at = CASE WHEN $2 = 'dead' THEN NOW() ELSE NULL END
       WHERE id = $1`, [job.id, dead ? 'dead' : 'queued', message, backoffMs(job.attempts, err)]);
    return { id: Number(job.id), status: dead ? 'dead' : 'queued', error: message };
  }
}

/** Claim and run one specific job right away (used for a first inline attempt). */
export async function runJobNow(jobId) {
  const job = (await query(
    `UPDATE sync_jobs SET status = 'running', locked_at = NOW(), attempts = attempts + 1
     WHERE id = $1 AND status = 'queued' RETURNING *`, [jobId])).rows[0];
  return job ? execute(job) : null;
}

/** Jobs left "running" by a process that died are put back in the queue. */
export async function recoverStaleJobs() {
  const result = await query(
    `UPDATE sync_jobs SET status = 'queued', locked_at = NULL
     WHERE status = 'running' AND locked_at < NOW() - ($1::int * INTERVAL '1 minute')`, [STALE_AFTER_MINUTES]);
  return result.rowCount;
}

export async function runDueJobs({ limit = 20, ignoreSchedule = false, businessId = null } = {}) {
  const claimed = (await query(
    `UPDATE sync_jobs SET status = 'running', locked_at = NOW(), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM sync_jobs
       WHERE status = 'queued' AND ($2 OR run_after <= NOW()) AND ($3::bigint IS NULL OR business_id = $3)
       ORDER BY run_after, id LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING *`, [limit, ignoreSchedule, businessId])).rows;
  const results = [];
  for (const job of claimed) results.push(await execute(job));
  return results;
}

let timer = null;
export function startJobWorker({ intervalMs = 15000, onTick } = {}) {
  if (timer) return;
  const tick = async () => {
    try {
      await recoverStaleJobs();
      if (onTick) await onTick();
      await runDueJobs();
    } catch (err) {
      console.error('[jobs] worker tick failed:', err.message);
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
}

export function stopJobWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function jobHealth(businessId) {
  const counts = (await query(
    `SELECT status, COUNT(*)::int AS n FROM sync_jobs WHERE business_id = $1 GROUP BY status`, [businessId])).rows;
  const recent = (await query(
    `SELECT id, kind, dedupe_key, status, attempts, max_attempts, run_after, last_error, updated_at, integration_id
     FROM sync_jobs WHERE business_id = $1 ORDER BY updated_at DESC LIMIT 30`, [businessId])).rows;
  return { counts: Object.fromEntries(counts.map((row) => [row.status, row.n])), recent };
}
