// Structured errors shared by every booking provider and route.
const HTTP_STATUS = {
  validation: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,              // requested inventory is no longer available
  quote_changed: 409,         // price or policy changed since the customer saw it
  not_ready: 409,             // resource is not operationally ready for immediate use
  idempotency_conflict: 409,
  config_conflict: 409,
  activation_blocked: 409,
  unsupported_operation: 422, // the authoritative system cannot do this
  provider_error: 502,
  provider_unavailable: 503,
};

export class BookingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BookingError';
    this.code = code;
    this.details = details;
    this.status = HTTP_STATUS[code] || 500;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const validationError = (message, details) => new BookingError('validation', message, details);
export const notFound = (message = 'Not found.') => new BookingError('not_found', message);
export const conflict = (message, details) => new BookingError('conflict', message, details);
export const unsupported = (message, details) => new BookingError('unsupported_operation', message, details);

/** Failure talking to an external system. `outcomeUnknown` means the request
 * may have been applied remotely and must be reconciled, never blindly retried. */
export class ProviderError extends BookingError {
  constructor(message, { kind = 'error', retryable = false, outcomeUnknown = false, retryAfterMs = null } = {}) {
    super(kind === 'unavailable' || kind === 'timeout' || kind === 'rate_limited' ? 'provider_unavailable' : 'provider_error',
      message, { kind, retryable, outcome_unknown: outcomeUnknown });
    this.kind = kind;
    this.retryable = retryable;
    this.outcomeUnknown = outcomeUnknown;
    this.retryAfterMs = retryAfterMs;
  }
}

export function sendError(res, err, fallback = 'Something went wrong.') {
  if (err instanceof BookingError) return res.status(err.status).json(err.toJSON());
  if (err?.name === 'ZodError') {
    return res.status(400).json({ error: { code: 'validation', message: 'Some fields are invalid.', details: { issues: err.issues } } });
  }
  console.error('[server]', err);
  return res.status(500).json({ error: { code: 'internal', message: fallback, details: {} } });
}
