// ─────────────────────────────────────────────────────────────────────────────
// MOCK PMS — a stand-in for a REMOTE reservation system, for development and
// tests only. It is NOT a real vendor API and models no real vendor's endpoints.
//
// Its tables (mock_pms_*) are the mock's own authoritative state. Nothing in the
// application reads them except through the connector in mockExternal.js, which
// is what lets tests change the "remote" side behind the platform's back.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import { query, withTransaction } from '../../services/db.js';

export const DEFAULT_MOCK_SETTINGS = {
  // What this imaginary system can do. Deliberately uneven, like real ones.
  services: {
    hotel: { supported: true, inventory_model: 'room_type' },   // sells room types; a physical room is assigned later
    restaurant: { supported: false },
    meeting: { supported: false },
  },
  webhooks: true,
  idempotent_create: false,
  lookup_by_correlation: true,
  modify: true,
  cancel: true,
  operational_updates: ['check_in', 'check_out'],
  // Injected faults, consumed by the connector.
  faults: { outage: false, timeout_after_accept: 0, rate_limit: 0 },
};

export async function mockSettings(integrationId, db) {
  const run = db ? db.query.bind(db) : query;
  const row = (await run('SELECT settings FROM mock_pms_accounts WHERE integration_id = $1', [integrationId])).rows[0];
  if (!row) return null;
  return { ...DEFAULT_MOCK_SETTINGS, ...row.settings, services: { ...DEFAULT_MOCK_SETTINGS.services, ...(row.settings.services || {}) },
    faults: { ...DEFAULT_MOCK_SETTINGS.faults, ...(row.settings.faults || {}) } };
}

export async function provisionMockAccount(integrationId, settings = {}) {
  await query(
    `INSERT INTO mock_pms_accounts (integration_id, settings) VALUES ($1, $2::jsonb)
     ON CONFLICT (integration_id) DO UPDATE SET settings = mock_pms_accounts.settings || EXCLUDED.settings`,
    [integrationId, JSON.stringify(settings)]);
}

export async function updateMockSettings(integrationId, patch) {
  const current = await mockSettings(integrationId);
  const next = { ...current, ...patch, services: { ...current.services, ...(patch.services || {}) }, faults: { ...current.faults, ...(patch.faults || {}) } };
  await query('UPDATE mock_pms_accounts SET settings = $2::jsonb WHERE integration_id = $1', [integrationId, JSON.stringify(next)]);
  return next;
}

export async function seedMockInventory(integrationId, types) {
  for (const type of types) {
    await query(
      `INSERT INTO mock_pms_room_types (integration_id, service_type, external_id, name, capacity, rate, units)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (integration_id, external_id) DO UPDATE SET name = EXCLUDED.name, capacity = EXCLUDED.capacity,
         rate = EXCLUDED.rate, units = EXCLUDED.units`,
      [integrationId, type.service_type, type.external_id, type.name, type.capacity, type.rate || 0, (type.units || []).length || type.unit_count || 1]);
    for (const unit of type.units || []) {
      await query(
        `INSERT INTO mock_pms_units (integration_id, type_external_id, external_id, code) VALUES ($1, $2, $3, $4)
         ON CONFLICT (integration_id, external_id) DO UPDATE SET code = EXCLUDED.code`,
        [integrationId, type.external_id, unit.external_id, unit.code]);
    }
  }
}

async function nextVersion(db, integrationId) {
  return Number((await db.query(
    'UPDATE mock_pms_accounts SET next_version = next_version + 1 WHERE integration_id = $1 RETURNING next_version - 1 AS v', [integrationId])).rows[0].v);
}

function view(row) {
  return { external_id: row.external_id, correlation_id: row.correlation_id, service_type: row.service_type,
    type_external_id: row.type_external_id, unit_external_id: row.unit_external_id, status: row.status, guest_name: row.guest_name,
    party_size: row.party_size, starts_at: row.starts_at, ends_at: row.ends_at, total: row.total === null ? null : String(Number(row.total)),
    version: Number(row.version) };
}

async function emit(db, integrationId, eventType, reservation) {
  await db.query(
    `INSERT INTO mock_pms_events (integration_id, event_id, event_type, reservation_external_id, version, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [integrationId, `evt_${crypto.randomUUID()}`, eventType, reservation.external_id, reservation.version, JSON.stringify(reservation)]);
}

async function freeUnits(db, integrationId, typeExternalId, startsAt, endsAt, exceptExternalId = null) {
  const type = (await db.query(
    'SELECT * FROM mock_pms_room_types WHERE integration_id = $1 AND external_id = $2 FOR UPDATE', [integrationId, typeExternalId])).rows[0];
  if (!type) return { type: null, free: 0 };
  const taken = Number((await db.query(
    `SELECT COUNT(*) AS n FROM mock_pms_reservations
     WHERE integration_id = $1 AND type_external_id = $2 AND status IN ('confirmed', 'in_house')
       AND starts_at < $4 AND ends_at > $3 AND ($5::text IS NULL OR external_id <> $5)`,
    [integrationId, typeExternalId, startsAt, endsAt, exceptExternalId])).rows[0].n);
  return { type, free: Number(type.units) - taken };
}

/** The remote system's own API surface, as plain functions. */
export const mockPms = {
  async listInventory(integrationId) {
    const types = (await query('SELECT * FROM mock_pms_room_types WHERE integration_id = $1 ORDER BY external_id', [integrationId])).rows;
    const units = (await query('SELECT * FROM mock_pms_units WHERE integration_id = $1 ORDER BY code', [integrationId])).rows;
    return {
      types: types.map((row) => ({ external_id: row.external_id, service_type: row.service_type, name: row.name,
        capacity: row.capacity, rate: String(Number(row.rate)), units: Number(row.units) })),
      units: units.map((row) => ({ external_id: row.external_id, type_external_id: row.type_external_id, code: row.code })),
    };
  },

  async availability(integrationId, { serviceType, startsAt, endsAt, partySize }) {
    return withTransaction(async (db) => {
      const types = (await db.query(
        'SELECT * FROM mock_pms_room_types WHERE integration_id = $1 AND service_type = $2 ORDER BY capacity, external_id', [integrationId, serviceType])).rows;
      const result = [];
      for (const type of types) {
        const { free } = await freeUnits(db, integrationId, type.external_id, startsAt, endsAt);
        result.push({ type_external_id: type.external_id, name: type.name, capacity: type.capacity, rate: String(Number(type.rate)),
          available_units: type.capacity >= partySize ? Math.max(free, 0) : 0 });
      }
      return result;
    });
  },

  async create(integrationId, input) {
    return withTransaction(async (db) => {
      if (input.idempotency_key) {
        const prior = (await db.query(
          'SELECT * FROM mock_pms_reservations WHERE integration_id = $1 AND idempotency_key = $2', [integrationId, input.idempotency_key])).rows[0];
        if (prior) return view(prior);
      }
      const { type, free } = await freeUnits(db, integrationId, input.type_external_id, input.starts_at, input.ends_at);
      if (!type) return { rejected: 'unknown_type' };
      if (free < 1 || type.capacity < input.party_size) return { rejected: 'no_availability' };
      const version = await nextVersion(db, integrationId);
      const row = (await db.query(
        `INSERT INTO mock_pms_reservations (integration_id, external_id, correlation_id, idempotency_key, service_type, type_external_id,
            status, guest_name, party_size, starts_at, ends_at, total, version)
         VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', $7, $8, $9, $10, $11, $12) RETURNING *`,
        [integrationId, `MOCK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`, input.correlation_id || null,
          input.idempotency_key || null, type.service_type, type.external_id, input.guest_name, input.party_size,
          input.starts_at, input.ends_at, input.total ?? null, version])).rows[0];
      await emit(db, integrationId, 'reservation.created', view(row));
      return view(row);
    });
  },

  async get(integrationId, externalId) {
    const row = (await query('SELECT * FROM mock_pms_reservations WHERE integration_id = $1 AND external_id = $2', [integrationId, externalId])).rows[0];
    return row ? view(row) : null;
  },

  async findByCorrelation(integrationId, correlationId) {
    const row = (await query('SELECT * FROM mock_pms_reservations WHERE integration_id = $1 AND correlation_id = $2', [integrationId, correlationId])).rows[0];
    return row ? view(row) : null;
  },

  async update(integrationId, externalId, patch, eventType = 'reservation.updated') {
    return withTransaction(async (db) => {
      const current = (await db.query(
        'SELECT * FROM mock_pms_reservations WHERE integration_id = $1 AND external_id = $2 FOR UPDATE', [integrationId, externalId])).rows[0];
      if (!current) return null;
      const next = { ...current, ...patch };
      if (patch.starts_at || patch.ends_at || patch.type_external_id || patch.party_size) {
        const { type, free } = await freeUnits(db, integrationId, next.type_external_id, next.starts_at, next.ends_at, externalId);
        if (!type || free < 1 || type.capacity < next.party_size) return { rejected: 'no_availability' };
      }
      const version = await nextVersion(db, integrationId);
      const row = (await db.query(
        `UPDATE mock_pms_reservations SET status = $3, guest_name = $4, party_size = $5, starts_at = $6, ends_at = $7,
            type_external_id = $8, unit_external_id = $9, total = $10, version = $11, updated_at = NOW()
         WHERE integration_id = $1 AND external_id = $2 RETURNING *`,
        [integrationId, externalId, next.status, next.guest_name, next.party_size, next.starts_at, next.ends_at,
          next.type_external_id, next.unit_external_id, next.total, version])).rows[0];
      await emit(db, integrationId, eventType, view(row));
      return view(row);
    });
  },

  /** Changes since a cursor, oldest first — for reconciliation polling. */
  async changes(integrationId, cursor) {
    const rows = (await query(
      `SELECT * FROM mock_pms_events WHERE integration_id = $1 AND id > $2 ORDER BY id LIMIT 200`, [integrationId, Number(cursor) || 0])).rows;
    return { events: rows.map((row) => ({ event_id: row.event_id, event_type: row.event_type, version: Number(row.version), reservation: row.payload })),
      cursor: rows.length ? String(rows[rows.length - 1].id) : String(cursor || 0) };
  },
};

/** Sign a webhook body the way this mock "sends" it. */
export function signMockWebhook(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}
