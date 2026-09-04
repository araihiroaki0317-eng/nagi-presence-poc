function requiredString(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(code);
  return number;
}

export function normalizeApprovedEnvelope(input = {}) {
  if (input.status !== 'approved') throw new Error('envelope_not_approved');
  if (input.approval_source !== 'explicit_user') throw new Error('explicit_approval_required');
  return Object.freeze({
    envelope_id: requiredString(input.envelope_id, 'envelope_id_required'),
    route_id: requiredString(input.route_id, 'route_id_required'),
    provider_id: requiredString(input.provider_id, 'provider_id_required'),
    model_id: requiredString(input.model_id, 'model_id_required'),
    currency: requiredString(input.currency, 'currency_required'),
    hard_limit_micros: positiveInteger(input.hard_limit_micros, 'hard_limit_required'),
    status: 'approved',
    approval_source: 'explicit_user',
    source_event_id: requiredString(input.source_event_id, 'source_event_id_required'),
    approved_at: requiredString(input.approved_at, 'approved_at_required'),
    allow_automatic_fallback: input.allow_automatic_fallback === true,
  });
}

export class RouteAccessController {
  constructor() {
    this.locks = new Map();
    this.envelopes = new Map();
  }

  lockRoute({ routeId, envelopeId = null, reason = 'hard_limit', sourceEventId = null } = {}) {
    const route = requiredString(routeId, 'route_id_required');
    const lock = Object.freeze({
      route_id: route,
      envelope_id: envelopeId || this.envelopes.get(route)?.envelope_id || null,
      reason,
      source_event_id: sourceEventId,
    });
    this.locks.set(route, lock);
    return lock;
  }

  applyApprovedEnvelope(input) {
    const envelope = normalizeApprovedEnvelope(input);
    const previousEnvelope = this.envelopes.get(envelope.route_id) || null;
    this.envelopes.set(envelope.route_id, envelope);
    const lock = this.locks.get(envelope.route_id);
    const isNewApproval = !lock || envelope.envelope_id !== lock.envelope_id;
    if (lock && isNewApproval) this.locks.delete(envelope.route_id);
    return {
      envelope,
      previous_envelope_id: previousEnvelope?.envelope_id || null,
      unlocked: Boolean(lock && isNewApproval),
    };
  }

  canUse(routeId) {
    return !this.locks.has(routeId);
  }

  lockFor(routeId) {
    return this.locks.get(routeId) || null;
  }

  envelopeFor(routeId) {
    return this.envelopes.get(routeId) || null;
  }
}
