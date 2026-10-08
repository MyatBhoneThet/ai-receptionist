import { query } from '../services/db.js';
import { buildChangeSummary } from '../services/appSettings.js';

/** Append to the business's audit trail. Pass a transaction client to make
 * the entry atomic with the change it describes. */
export async function recordAudit(db, { businessId, actor, action, entity, entityId = null, before = {}, after = {} }) {
  const run = db ? db.query.bind(db) : query;
  await run(
    `INSERT INTO audit_logs (business_id, actor_email, actor_user_id, action, entity, entity_id, before_state, after_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
    [businessId, actor?.email || actor?.label || 'system', actor?.userId || null, action, entity, entityId,
      JSON.stringify(before ?? {}), JSON.stringify(after ?? {})]
  );
}

export async function listAudit(businessId, { limit = 50, entity = '' } = {}) {
  const values = [businessId, Math.min(Math.max(Number(limit) || 50, 1), 200)];
  if (entity) values.push(entity);
  const result = await query(
    `SELECT id, actor_email, action, entity, entity_id, before_state, after_state, created_at
     FROM audit_logs WHERE business_id = $1 ${entity ? 'AND entity = $3' : ''}
     ORDER BY created_at DESC, id DESC LIMIT $2`, values);
  return result.rows.map((row) => ({ ...row, change_summary: buildChangeSummary(row.before_state, row.after_state) }));
}
