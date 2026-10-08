// Connections to external reservation systems: configuration, capability
// discovery, inventory import and mapping. Secrets stay server-side.
import crypto from 'node:crypto';
import { z } from 'zod';
import { query, withTransaction } from '../services/db.js';
import { BookingError, notFound, validationError } from './errors.js';
import { encryptSecret, decryptSecret } from './secrets.js';
import { recordAudit } from './audit.js';
import { SERVICE_TYPES } from './config.js';
import { getConnector, listConnectors } from '../booking/providers/index.js';
import { provisionMockAccount } from '../booking/providers/mockPms.js';

const createSchema = z.object({
  provider_key: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  config: z.record(z.any()).default({}),
  credentials: z.record(z.string()).optional(),
}).strict();

/** What the browser and the AI may see: never credentials or webhook secrets. */
export function publicIntegration(row) {
  if (!row) return null;
  const connector = getConnector(row.provider_key);
  return {
    id: Number(row.id), provider_key: row.provider_key, provider_label: connector?.label || row.provider_key,
    name: row.name, environment: row.environment, is_mock: row.environment === 'mock',
    production_ready: Boolean(connector?.production_ready),
    status: row.status, config: row.config || {}, capabilities: row.capabilities || {},
    has_credentials: Boolean(row.credentials_enc),
    last_tested_at: row.last_tested_at, last_test_result: row.last_test_result,
    last_reconciled_at: row.last_reconciled_at, last_error: row.last_error, created_at: row.created_at,
  };
}

export function connectorContext(integration) {
  const connector = getConnector(integration.provider_key);
  if (!connector) throw new BookingError('provider_error', 'No connector is installed for this integration.');
  return {
    connector,
    ctx: {
      integration: { id: Number(integration.id), business_id: Number(integration.business_id), name: integration.name },
      config: integration.config || {},
      credentials: integration.credentials_enc ? decryptSecret(integration.credentials_enc) : null,
      webhookSecret: integration.webhook_secret_enc ? decryptSecret(integration.webhook_secret_enc) : null,
    },
  };
}

export async function getIntegration(businessId, integrationId, db) {
  const run = db ? db.query.bind(db) : query;
  return (await run('SELECT * FROM integrations WHERE id = $1 AND business_id = $2', [integrationId, businessId])).rows[0] || null;
}

export async function listIntegrations(businessId) {
  return (await query('SELECT * FROM integrations WHERE business_id = $1 ORDER BY id', [businessId])).rows.map(publicIntegration);
}

export { listConnectors };

export async function createIntegration(business, input, actor) {
  const data = createSchema.parse(input);
  const connector = getConnector(data.provider_key);
  if (!connector) {
    throw validationError('No connector exists for that system yet. A production connector requires vendor selection, documentation and credentials.');
  }
  if (connector.environment === 'production' && !connector.production_ready) {
    throw new BookingError('unsupported_operation', 'This connector has not been validated for production use.');
  }
  const webhookSecret = crypto.randomBytes(24).toString('hex');
  const row = (await query(
    `INSERT INTO integrations (business_id, provider_key, name, environment, config, credentials_enc, webhook_secret_enc, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) RETURNING *`,
    [business.id, connector.key, data.name, connector.environment, JSON.stringify(data.config),
      data.credentials ? encryptSecret(data.credentials) : null, encryptSecret(webhookSecret), actor?.userId || null])).rows[0];
  if (connector.key === 'mock') await provisionMockAccount(row.id, data.config.mock || {});
  await recordAudit(null, { businessId: business.id, actor, action: 'create', entity: 'integration', entityId: row.id,
    after: { name: row.name, provider: row.provider_key, environment: row.environment } });
  // Shown once so the remote system can be configured to sign its webhooks.
  return { ...publicIntegration(row), webhook_secret_once: webhookSecret };
}

export async function testIntegration(business, integrationId, actor) {
  const integration = await getIntegration(business.id, integrationId);
  if (!integration) throw notFound('Integration not found.');
  const { connector, ctx } = connectorContext(integration);
  let result;
  let capabilities = integration.capabilities;
  try {
    result = await connector.testConnection(ctx);
    capabilities = await connector.capabilities(ctx);
  } catch (err) {
    result = { ok: false, message: err.message };
  }
  const row = (await query(
    `UPDATE integrations SET status = $2, capabilities = $3::jsonb, last_tested_at = NOW(), last_test_result = $4::jsonb, last_error = $5
     WHERE id = $1 RETURNING *`,
    [integration.id, result.ok ? 'connected' : 'error', JSON.stringify(capabilities || {}), JSON.stringify(result), result.ok ? null : result.message])).rows[0];
  await recordAudit(null, { businessId: business.id, actor, action: 'test', entity: 'integration', entityId: row.id, after: { ok: result.ok } });
  return publicIntegration(row);
}

/**
 * Import the external system's types and physical units as provider-owned
 * local mirrors. Provider-owned fields are read-only locally; only the display
 * name can be edited, and it never overrides provider availability or rules.
 */
export async function importInventory(business, integrationId, actor) {
  const integration = await getIntegration(business.id, integrationId);
  if (!integration) throw notFound('Integration not found.');
  const { connector, ctx } = connectorContext(integration);
  const remote = await connector.listInventory(ctx);
  const capabilities = await connector.capabilities(ctx);
  return withTransaction(async (db) => {
    const summary = { types_created: 0, resources_created: 0, types_seen: remote.types.length, resources_seen: remote.resources.length, skipped: [] };
    for (const type of remote.types) {
      if (!SERVICE_TYPES.includes(type.service_type) || !capabilities.services?.[type.service_type]?.supported) {
        summary.skipped.push({ external_id: type.external_id, reason: 'service_not_supported_by_provider' });
        continue;
      }
      const service = (await db.query('SELECT * FROM business_services WHERE business_id = $1 AND service_type = $2', [business.id, type.service_type])).rows[0];
      if (service.booking_source !== 'external' || Number(service.integration_id) !== Number(integration.id)) {
        summary.skipped.push({ external_id: type.external_id, reason: 'service_not_sourced_from_this_integration' });
        continue;
      }
      let mapping = (await db.query(
        `SELECT * FROM external_mappings WHERE integration_id = $1 AND kind = 'resource_type' AND external_id = $2 FOR UPDATE`,
        [integration.id, type.external_id])).rows[0];
      if (!mapping?.resource_type_id) {
        const local = (await db.query(
          `INSERT INTO resource_types (business_id, service_type, name, managed_by) VALUES ($1, $2, $3, 'external') RETURNING id`,
          [business.id, type.service_type, await freeTypeName(db, business.id, type.service_type, type.name)])).rows[0];
        summary.types_created += 1;
        mapping = (await db.query(
          `INSERT INTO external_mappings (business_id, integration_id, service_type, kind, external_id, external_name, external_data, resource_type_id)
           VALUES ($1, $2, $3, 'resource_type', $4, $5, $6::jsonb, $7)
           ON CONFLICT (integration_id, kind, external_id) DO UPDATE SET resource_type_id = EXCLUDED.resource_type_id RETURNING *`,
          [business.id, integration.id, type.service_type, type.external_id, type.name, JSON.stringify(type.data || {}), local.id])).rows[0];
      }
      await db.query(`UPDATE external_mappings SET external_name = $2, external_data = $3::jsonb, last_seen_at = NOW() WHERE id = $1`,
        [mapping.id, type.name, JSON.stringify(type.data || {})]);
    }
    for (const unit of remote.resources) {
      const typeMapping = (await db.query(
        `SELECT * FROM external_mappings WHERE integration_id = $1 AND kind = 'resource_type' AND external_id = $2`,
        [integration.id, unit.external_type_id])).rows[0];
      if (!typeMapping?.resource_type_id) continue;
      const existing = (await db.query(
        `SELECT * FROM external_mappings WHERE integration_id = $1 AND kind = 'resource' AND external_id = $2`, [integration.id, unit.external_id])).rows[0];
      if (existing?.resource_id) {
        await db.query('UPDATE external_mappings SET last_seen_at = NOW(), external_name = $2 WHERE id = $1', [existing.id, unit.code]);
        continue;
      }
      const clash = (await db.query(
        `SELECT 1 FROM resources WHERE business_id = $1 AND service_type = $2 AND lower(code) = lower($3) AND archived_at IS NULL`,
        [business.id, typeMapping.service_type, unit.code])).rows.length;
      if (clash) { summary.skipped.push({ external_id: unit.external_id, reason: 'code_already_used_locally' }); continue; }
      const local = (await db.query(
        `INSERT INTO resources (business_id, service_type, resource_type_id, code, managed_by) VALUES ($1, $2, $3, $4, 'external') RETURNING id`,
        [business.id, typeMapping.service_type, typeMapping.resource_type_id, unit.code])).rows[0];
      summary.resources_created += 1;
      await db.query(
        `INSERT INTO external_mappings (business_id, integration_id, service_type, kind, external_id, external_name, resource_id)
         VALUES ($1, $2, $3, 'resource', $4, $5, $6)
         ON CONFLICT (integration_id, kind, external_id) DO UPDATE SET resource_id = EXCLUDED.resource_id, last_seen_at = NOW()`,
        [business.id, integration.id, typeMapping.service_type, unit.external_id, unit.code, local.id]);
    }
    await recordAudit(db, { businessId: business.id, actor, action: 'import_inventory', entity: 'integration', entityId: integration.id, after: summary });
    return summary;
  });
}

async function freeTypeName(db, businessId, serviceType, name) {
  const taken = (await db.query(
    `SELECT 1 FROM resource_types WHERE business_id = $1 AND service_type = $2 AND lower(name) = lower($3) AND archived_at IS NULL`,
    [businessId, serviceType, name])).rows.length;
  return taken ? `${name} (external)` : name;
}

export async function listMappings(businessId, integrationId) {
  return (await query(
    `SELECT m.id, m.service_type, m.kind, m.external_id, m.external_name, m.external_data, m.last_seen_at,
            m.resource_type_id, t.name AS resource_type_name, m.resource_id, r.code AS resource_code
     FROM external_mappings m
     LEFT JOIN resource_types t ON t.id = m.resource_type_id LEFT JOIN resources r ON r.id = m.resource_id
     WHERE m.business_id = $1 AND m.integration_id = $2 ORDER BY m.kind DESC, m.external_id`, [businessId, integrationId])).rows;
}

export async function integrationHealth(businessId, integrationId) {
  const integration = await getIntegration(businessId, integrationId);
  if (!integration) throw notFound('Integration not found.');
  const events = (await query(
    `SELECT id, direction, event_type, external_reservation_id, external_version, booking_id, outcome, detail, created_at
     FROM sync_events WHERE business_id = $1 AND integration_id = $2 ORDER BY id DESC LIMIT 50`, [businessId, integrationId])).rows;
  const unresolved = (await query(
    `SELECT c.id, c.command, c.service_type, c.status, c.booking_id, c.correlation_id, c.created_at, c.error
     FROM booking_commands c WHERE c.business_id = $1 AND c.provider <> 'internal' AND c.status IN ('in_progress', 'unknown')
     ORDER BY c.id DESC LIMIT 50`, [businessId])).rows;
  const attention = (await query(
    `SELECT id, service_type, reservation_name, status, sync_status, attention_reason, starts_at FROM bookings
     WHERE business_id = $1 AND integration_id = $2 AND (sync_status IN ('unknown', 'failed', 'attention') OR status = 'awaiting_confirmation')
     ORDER BY id DESC LIMIT 50`, [businessId, integrationId])).rows;
  return { integration: publicIntegration(integration), events, unresolved_commands: unresolved, attention };
}
