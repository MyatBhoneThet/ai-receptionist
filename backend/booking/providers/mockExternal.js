// Connector for the MOCK PMS. This is the only code that talks to the mock's
// authoritative store. It implements the provider interface in ./index.js and
// can inject outages, rate limits and "accepted, then the response was lost".
import crypto from 'node:crypto';
import { ProviderError } from '../../platform/errors.js';
import { mockPms, mockSettings, updateMockSettings, signMockWebhook } from './mockPms.js';

async function settingsOrFail(ctx) {
  const settings = await mockSettings(ctx.integration.id);
  if (!settings) throw new ProviderError('The mock provider account has not been provisioned.', { kind: 'unavailable' });
  return settings;
}

/** Faults that prevent the request reaching the remote system at all. */
async function beforeCall(ctx) {
  const settings = await settingsOrFail(ctx);
  if (settings.faults.outage) throw new ProviderError('The connected reservation system is not responding.', { kind: 'unavailable', retryable: true });
  if (settings.faults.rate_limit > 0) {
    await updateMockSettings(ctx.integration.id, { faults: { rate_limit: settings.faults.rate_limit - 1 } });
    throw new ProviderError('The connected reservation system is rate limiting requests.', { kind: 'rate_limited', retryable: true, retryAfterMs: 1000 });
  }
  return settings;
}

function assertService(settings, serviceType) {
  if (!settings.services[serviceType]?.supported) {
    throw new ProviderError(`The connected system does not manage ${serviceType} reservations.`, { kind: 'unsupported' });
  }
}

const STATUS = { confirmed: 'confirmed', in_house: 'checked_in', checked_out: 'completed', cancelled: 'cancelled', no_show: 'no_show' };

function normalize(remote) {
  return {
    external_reservation_id: remote.external_id,
    correlation_id: remote.correlation_id,
    service_type: remote.service_type,
    status: STATUS[remote.status] || 'awaiting_confirmation',
    external_type_id: remote.type_external_id,
    // null until the remote system assigns a physical room. Never invented.
    external_resource_id: remote.unit_external_id || null,
    guest_name: remote.guest_name, party_size: remote.party_size,
    starts_at: new Date(remote.starts_at), ends_at: new Date(remote.ends_at),
    total: remote.total, version: remote.version,
  };
}

export const mockExternalProvider = {
  key: 'mock',
  label: 'Mock PMS (development only — not a real reservation system)',
  environment: 'mock',
  production_ready: false,

  async testConnection(ctx) {
    await beforeCall(ctx);
    return { ok: true, message: 'Connected to the MOCK provider. No real reservation system is involved.' };
  },

  async capabilities(ctx) {
    const settings = await settingsOrFail(ctx);
    return {
      services: settings.services,
      physical_assignment: Object.values(settings.services).some((service) => service.supported && service.inventory_model === 'physical'),
      webhooks: settings.webhooks, idempotent_create: settings.idempotent_create, lookup_by_correlation: settings.lookup_by_correlation,
      modify: settings.modify, cancel: settings.cancel, operational_updates: settings.operational_updates,
      editable_fields: [],
    };
  },

  async listInventory(ctx) {
    await beforeCall(ctx);
    const inventory = await mockPms.listInventory(ctx.integration.id);
    return {
      types: inventory.types.map((type) => ({ external_id: type.external_id, service_type: type.service_type, name: type.name,
        data: { capacity: type.capacity, rate: type.rate, units: type.units } })),
      resources: inventory.units.map((unit) => ({ external_id: unit.external_id, external_type_id: unit.type_external_id, code: unit.code })),
    };
  },

  async checkAvailability(ctx, request) {
    const settings = await beforeCall(ctx);
    assertService(settings, request.service_type);
    const rows = await mockPms.availability(ctx.integration.id, { serviceType: request.service_type,
      startsAt: request.starts_at, endsAt: request.ends_at, partySize: request.people });
    return { fetched_at: new Date().toISOString(), options: rows.map((row) => ({ external_type_id: row.type_external_id, name: row.name,
      capacity: row.capacity, available_units: row.available_units, rate: row.rate })) };
  },

  async createReservation(ctx, request) {
    const settings = await beforeCall(ctx);
    assertService(settings, request.service_type);
    const remote = await mockPms.create(ctx.integration.id, { type_external_id: request.external_type_id,
      correlation_id: request.correlation_id, idempotency_key: settings.idempotent_create ? request.idempotency_key : null,
      guest_name: request.guest_name, party_size: request.people, starts_at: request.starts_at, ends_at: request.ends_at, total: request.total });
    if (remote.rejected) throw new ProviderError('The connected system has no availability for that request.', { kind: 'rejected' });
    if (settings.faults.timeout_after_accept > 0) {
      // The remote system HAS created the reservation; only the reply is lost.
      await updateMockSettings(ctx.integration.id, { faults: { timeout_after_accept: settings.faults.timeout_after_accept - 1 } });
      throw new ProviderError('The connected system did not respond in time.', { kind: 'timeout', retryable: false, outcomeUnknown: true });
    }
    return normalize(remote);
  },

  async getReservation(ctx, externalReservationId) {
    await beforeCall(ctx);
    const remote = await mockPms.get(ctx.integration.id, externalReservationId);
    return remote ? normalize(remote) : null;
  },

  async findByCorrelationId(ctx, correlationId) {
    const settings = await beforeCall(ctx);
    if (!settings.lookup_by_correlation) throw new ProviderError('The connected system cannot look up requests by reference.', { kind: 'unsupported' });
    const remote = await mockPms.findByCorrelation(ctx.integration.id, correlationId);
    return remote ? normalize(remote) : null;
  },

  async modifyReservation(ctx, externalReservationId, changes) {
    const settings = await beforeCall(ctx);
    if (!settings.modify) throw new ProviderError('The connected system does not accept changes through its API.', { kind: 'unsupported' });
    const remote = await mockPms.update(ctx.integration.id, externalReservationId, {
      ...(changes.starts_at ? { starts_at: changes.starts_at } : {}), ...(changes.ends_at ? { ends_at: changes.ends_at } : {}),
      ...(changes.people ? { party_size: changes.people } : {}), ...(changes.guest_name ? { guest_name: changes.guest_name } : {}),
      ...(changes.total !== undefined ? { total: changes.total } : {}) });
    if (!remote) throw new ProviderError('The connected system has no such reservation.', { kind: 'rejected' });
    if (remote.rejected) throw new ProviderError('The connected system has no availability for that change.', { kind: 'rejected' });
    return normalize(remote);
  },

  async cancelReservation(ctx, externalReservationId) {
    const settings = await beforeCall(ctx);
    if (!settings.cancel) throw new ProviderError('The connected system does not accept cancellations through its API.', { kind: 'unsupported' });
    const remote = await mockPms.update(ctx.integration.id, externalReservationId, { status: 'cancelled' }, 'reservation.cancelled');
    if (!remote) throw new ProviderError('The connected system has no such reservation.', { kind: 'rejected' });
    return normalize(remote);
  },

  async applyOperationalUpdate(ctx, externalReservationId, action) {
    const settings = await beforeCall(ctx);
    if (!settings.operational_updates.includes(action)) throw new ProviderError(`The connected system does not accept "${action}".`, { kind: 'unsupported' });
    const status = { check_in: 'in_house', check_out: 'checked_out' }[action];
    const remote = await mockPms.update(ctx.integration.id, externalReservationId, { status });
    if (!remote) throw new ProviderError('The connected system has no such reservation.', { kind: 'rejected' });
    return normalize(remote);
  },

  async listChanges(ctx, cursor) {
    await beforeCall(ctx);
    const { events, cursor: next } = await mockPms.changes(ctx.integration.id, cursor);
    return { cursor: next, events: events.map((event) => ({ event_id: event.event_id, event_type: event.event_type, reservation: normalize(event.reservation) })) };
  },

  /** Authenticate and decode an inbound webhook. Returns null when the signature is wrong. */
  parseWebhook(ctx, rawBody, headers) {
    const secret = ctx.webhookSecret;
    const given = String(headers['x-mock-signature'] || '');
    const expected = secret ? signMockWebhook(secret, rawBody) : '';
    if (!secret || given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null;
    const body = JSON.parse(rawBody);
    return (body.events || []).map((event) => ({ event_id: event.event_id, event_type: event.event_type, reservation: normalize(event.reservation) }));
  },
};
