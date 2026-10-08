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

const envNotificationSettings = () => ({
  provider: process.env.STAFF_WEBHOOK_PROVIDER || 'slack',
  webhook_url: process.env.STAFF_WEBHOOK_URL || '',
  alert_email: process.env.STAFF_ALERT_EMAIL || '',
});
const emptyNotificationSettings = () => ({ provider: 'slack', webhook_url: '', alert_email: '' });

/**
 * Notification settings for one business. Environment-variable defaults apply
 * only to the pre-platform (legacy) business, so one business's alerts can
 * never be delivered to another's webhook.
 */
export async function getNotificationSettings(businessId, { allowEnvFallback = false } = {}) {
  if (!businessId) return envNotificationSettings();
  if (process.env.NODE_ENV === 'test' && process.env.USE_APP_SETTINGS_QUERY_IN_TEST !== 'true') {
    return allowEnvFallback ? envNotificationSettings() : emptyNotificationSettings();
  }
  const fallback = allowEnvFallback ? envNotificationSettings() : emptyNotificationSettings();
  try {
    const result = await query(
      `SELECT key, value FROM app_settings WHERE business_id = $2 AND key = ANY($1::text[])`,
      [NOTIFICATION_KEYS, businessId]
    );
    const rows = Object.fromEntries(result.rows.map((row) => [row.key, row]));
    return {
      provider: unwrapJsonValue(rows.notification_provider, fallback.provider),
      webhook_url: unwrapJsonValue(rows.staff_webhook_url, fallback.webhook_url),
      alert_email: unwrapJsonValue(rows.staff_alert_email, fallback.alert_email),
    };
  } catch (err) {
    console.error('[getNotificationSettings] Falling back to defaults:', err.message);
    return fallback;
  }
}

export async function upsertNotificationSettings(businessId, { provider, webhook_url, alert_email }, actor = {}) {
  const previous = await getNotificationSettings(businessId);
  const entries = [
    ['notification_provider', provider],
    ['staff_webhook_url', webhook_url],
    ['staff_alert_email', alert_email],
  ];

  for (const [key, value] of entries) {
    await query(
      `INSERT INTO app_settings (business_id, key, value)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (business_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [businessId, key, JSON.stringify({ value })]
    );
  }

  await query(
    `INSERT INTO audit_logs (business_id, actor_email, actor_user_id, action, entity, before_state, after_state)
     VALUES ($1, $2, $3, 'update', 'notification_settings', $4::jsonb, $5::jsonb)`,
    [businessId, actor.email || 'system', actor.userId || null, JSON.stringify(previous),
      JSON.stringify({ provider, webhook_url, alert_email })]
  );

  return getNotificationSettings(businessId);
}

export async function getBusinessSetting(businessId, key) {
  const result = await query('SELECT value FROM app_settings WHERE business_id = $1 AND key = $2', [businessId, key]);
  return result.rows[0] ? unwrapJsonValue(result.rows[0], '') : '';
}

export async function setBusinessSetting(businessId, key, value) {
  await query(
    `INSERT INTO app_settings (business_id, key, value) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (business_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [businessId, key, JSON.stringify({ value })]);
}

export { buildChangeSummary };
