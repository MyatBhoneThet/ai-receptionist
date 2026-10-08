// Booking providers.
//
// Every service of every business has exactly ONE authoritative booking source:
//   internal  → providers/internal.js (our database)
//   external  → a connector registered below, reached through booking/external.js
//
// ── External connector interface ─────────────────────────────────────────────
// A connector is an object with these members. `ctx` is
//   { integration, config, credentials, webhookSecret }  (credentials decrypted server-side only)
//
//   key, label, environment ('mock' | 'sandbox' | 'production'), production_ready
//   testConnection(ctx)                         → { ok, message }
//   capabilities(ctx)                           → see CAPABILITY_SHAPE
//   listInventory(ctx)                          → { types[], resources[] }  for import + mapping
//   checkAvailability(ctx, request)             → { fetched_at, options[] } authoritative, never cached
//   createReservation(ctx, request)             → normalized reservation
//   getReservation(ctx, externalReservationId)  → normalized reservation | null
//   findByCorrelationId(ctx, correlationId)     → normalized reservation | null   (optional capability)
//   modifyReservation(ctx, id, changes)         → normalized reservation
//   cancelReservation(ctx, id)                  → normalized reservation
//   applyOperationalUpdate(ctx, id, action)     → normalized reservation
//   listChanges(ctx, cursor)                    → { cursor, events[] }  for reconciliation
//   parseWebhook(ctx, rawBody, headers)         → events[] | null (null = failed authentication)
//
// Normalized reservation:
//   { external_reservation_id, correlation_id, service_type, status, external_type_id,
//     external_resource_id (null when no physical unit is assigned), guest_name, party_size,
//     starts_at, ends_at, total, version (monotonic, for ordering) }
//
// Connectors signal failure with ProviderError; `outcomeUnknown: true` means the
// request may have been applied remotely.
import { mockExternalProvider } from './mockExternal.js';

export const CAPABILITY_SHAPE = {
  services: { hotel: { supported: false, inventory_model: 'room_type | physical' } },
  physical_assignment: false, webhooks: false, idempotent_create: false, lookup_by_correlation: false,
  modify: false, cancel: false, operational_updates: [], editable_fields: [],
};

// No real PMS vendor has been selected. A production connector is added here
// once its documentation, credentials and capabilities have been validated.
const connectors = new Map([[mockExternalProvider.key, mockExternalProvider]]);

export function getConnector(key) {
  return connectors.get(key) || null;
}

export function listConnectors() {
  return [...connectors.values()].map((connector) => ({ key: connector.key, label: connector.label,
    environment: connector.environment, production_ready: connector.production_ready }));
}
