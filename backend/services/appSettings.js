import { query } from './db.js';

const NOTIFICATION_KEYS = ['notification_provider', 'staff_webhook_url', 'staff_alert_email'];

function unwrapJsonValue(row, fallback = '') {
  const value = row?.value;
  if (value && typeof value === 'object' && 'value' in value) return value.value ?? fallback;
  return value ?? fallback;
}

function flattenJsonRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  if ('provider' in value || 'webhook_url' in value || 'alert_email' in value) return value;
  return value;
}

function buildChangeSummary(beforeState = {}, afterState = {}) {
  const before = flattenJsonRecord(beforeState);
  const after = flattenJsonRecord(afterState);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes = [];

  for (const key of keys) {
    const prev = before[key] ?? '';
    const next = after[key] ?? '';
    if (String(prev) === String(next)) continue;
    changes.push({ field: key, before: prev, after: next });
  }

  return changes;
}

export async function getNotificationSettings() {
  if (process.env.NODE_ENV === 'test' && process.env.USE_APP_SETTINGS_QUERY_IN_TEST !== 'true') {
    return {
      provider: process.env.STAFF_WEBHOOK_PROVIDER || 'slack',
      webhook_url: process.env.STAFF_WEBHOOK_URL || '',
      alert_email: process.env.STAFF_ALERT_EMAIL || '',
    };
  }

  try {
    const result = await query(
      `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
      [NOTIFICATION_KEYS]
    );

    const rows = Object.fromEntries(result.rows.map((row) => [row.key, row]));

    return {
      provider: unwrapJsonValue(rows.notification_provider, process.env.STAFF_WEBHOOK_PROVIDER || 'slack'),
      webhook_url: unwrapJsonValue(rows.staff_webhook_url, process.env.STAFF_WEBHOOK_URL || ''),
      alert_email: unwrapJsonValue(rows.staff_alert_email, process.env.STAFF_ALERT_EMAIL || ''),
    };
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.error('[getNotificationSettings] Falling back to env defaults:', err.message);
    }
    return {
      provider: process.env.STAFF_WEBHOOK_PROVIDER || 'slack',
      webhook_url: process.env.STAFF_WEBHOOK_URL || '',
      alert_email: process.env.STAFF_ALERT_EMAIL || '',
    };
  }
}

export async function upsertNotificationSettings({ provider, webhook_url, alert_email }, actorEmail = 'admin') {
  const previous = await getNotificationSettings();
  const entries = [
    ['notification_provider', provider],
    ['staff_webhook_url', webhook_url],
    ['staff_alert_email', alert_email],
  ];

  for (const [key, value] of entries) {
    await query(
      `INSERT INTO app_settings (key, value)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify({ value })]
    );
  }

  await query(
    `INSERT INTO audit_logs (actor_email, action, entity, before_state, after_state)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [
      actorEmail,
      'update',
      'notification_settings',
      JSON.stringify(previous),
      JSON.stringify({ provider, webhook_url, alert_email }),
    ]
  );

  return getNotificationSettings();
}

export async function listRecentAuditLogs(limit = 20, entity = '') {
  const values = [Math.min(Number(limit) || 20, 100)];
  const where = entity ? 'WHERE entity = $2' : '';
  if (entity) values.push(entity);

  const result = await query(
    `SELECT id, actor_email, action, entity, before_state, after_state, created_at
     FROM audit_logs
     ${where}
     ORDER BY created_at DESC
     LIMIT $1`,
    values
  );

  return result.rows.map((row) => ({
    ...row,
    change_summary: buildChangeSummary(row.before_state, row.after_state),
  }));
}

export { buildChangeSummary };

export async function recordAuditLog({
  actorEmail = 'admin',
  action,
  entity,
  beforeState = {},
  afterState = {},
}) {
  await query(
    `INSERT INTO audit_logs (actor_email, action, entity, before_state, after_state)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [
      actorEmail,
      action,
      entity,
      JSON.stringify(beforeState),
      JSON.stringify(afterState),
    ]
  );
}
