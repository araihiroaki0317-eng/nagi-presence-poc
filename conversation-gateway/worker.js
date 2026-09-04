import { TEXT_GATEWAY_SCHEMA_VERSION } from '../gateway/text-protocol.js';
import { verifyDeviceToken } from './auth.js';

const MAX_MESSAGE_CHARACTERS = 2000;
const MAX_CONTEXT_CHARACTERS = 12000;

function cors(origin, allowedOrigin) {
  return {
    'Access-Control-Allow-Origin': origin === allowedOrigin ? origin : allowedOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Vary': 'Origin',
  };
}

function json(payload, status, origin, allowedOrigin) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...cors(origin, allowedOrigin),
    },
  });
}

function error(code, message, retryable, status, origin, allowedOrigin, details = {}) {
  return json({ error: { code, message, retryable, ...details } }, status, origin, allowedOrigin);
}

async function readJson(request) {
  try { return await request.json(); }
  catch { return null; }
}

function validateRequest(body) {
  if (!body || body.schema_version !== TEXT_GATEWAY_SCHEMA_VERSION) return 'schema_invalid';
  if (!body.conversation_id || !body.turn_id) return 'identity_required';
  if (body.input?.type !== 'text' || typeof body.input?.content !== 'string') return 'text_input_required';
  if (body.input.content.length > MAX_MESSAGE_CHARACTERS) return 'message_too_large';
  if (String(body.context || '').length > MAX_CONTEXT_CHARACTERS) return 'context_too_large';
  if (!Array.isArray(body.output_channels) || !body.output_channels.includes('text')) return 'text_output_required';
  return null;
}

async function bindingJson(binding, url, body) {
  if (!binding?.fetch) throw new Error('binding_missing');
  const response = await binding.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload = null;
  try { payload = await response.json(); } catch {}
  return { response, payload };
}

async function releaseReservation(binding, reservationId) {
  if (!reservationId) return;
  try {
    await bindingJson(binding, 'https://budget.internal/release', { reservation_id: reservationId });
  } catch {}
}

async function commitReservation(binding, reservationId, usage) {
  if (!reservationId) return 'reservation_held';
  try {
    const committed = await bindingJson(binding, 'https://budget.internal/commit', {
      reservation_id: reservationId,
      usage: usage || null,
    });
    if (!committed.response.ok || committed.payload?.ok !== true) return 'reservation_held';
    return committed.payload?.estimate_exceeded === true ? 'estimate_exceeded' : 'committed';
  } catch {
    return 'reservation_held';
  }
}

export async function handleRequest(request, env = {}) {
  const allowedOrigin = String(env.ALLOWED_ORIGIN || '').trim();
  const origin = request.headers.get('Origin') || '';
  if (!allowedOrigin) {
    return error('origin_not_configured', 'Gateway origin is not configured.', false, 503, origin, 'null');
  }
  if (origin !== allowedOrigin) {
    return error('origin_forbidden', 'Origin is not allowed.', false, 403, origin, allowedOrigin);
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors(origin, allowedOrigin) });
  }

  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json({
      ok: true,
      service: 'nagi-conversation-gateway',
      provider_configured: Boolean(env.TEXT_PROVIDER?.fetch),
      budget_guard_configured: Boolean(env.BUDGET_GUARD?.fetch),
      cost_estimator_configured: Boolean(env.COST_ESTIMATOR?.fetch),
      device_auth_configured: Boolean(env.DEVICE_TOKEN_SHA256),
    }, 200, origin, allowedOrigin);
  }

  if (request.method !== 'POST' || url.pathname !== '/v1/text/respond') {
    return error('not_found', 'Endpoint not found.', false, 404, origin, allowedOrigin);
  }

  const auth = await verifyDeviceToken(request, env.DEVICE_TOKEN_SHA256);
  if (!auth.ok) {
    const notConfigured = auth.reason === 'device_auth_not_configured';
    return error(auth.reason, 'Device authorization failed.', false, notConfigured ? 503 : 401, origin, allowedOrigin);
  }

  const body = await readJson(request);
  const invalid = validateRequest(body);
  if (invalid) {
    const tooLarge = invalid === 'message_too_large' || invalid === 'context_too_large';
    return error(invalid, 'Gateway request is invalid.', false, tooLarge ? 413 : 400, origin, allowedOrigin);
  }

  if (!env.BUDGET_GUARD?.fetch) {
    return error('budget_guard_not_configured', 'Budget guard is required.', false, 503, origin, allowedOrigin);
  }
  if (!env.COST_ESTIMATOR?.fetch) {
    return error('cost_estimator_not_configured', 'Cost estimator is required.', false, 503, origin, allowedOrigin);
  }
  let estimate;
  try {
    estimate = await bindingJson(env.COST_ESTIMATOR, 'https://cost.internal/estimate', {
      input_characters: body.input.content.length,
      context_characters: String(body.context || '').length,
      output_character_limit: 2000,
    });
  } catch {
    return error('cost_estimator_unavailable', 'Cost estimator is unavailable.', true, 503, origin, allowedOrigin);
  }
  const estimatedCostMicros = Number(estimate.payload?.estimated_cost_micros);
  const estimatedProviderId = String(estimate.payload?.provider_id || '').trim();
  const estimatedModelId = String(estimate.payload?.model_id || '').trim();
  const maxOutputUnits = Number(estimate.payload?.max_output_units);
  if (!estimate.response.ok
    || !Number.isSafeInteger(estimatedCostMicros)
    || estimatedCostMicros <= 0
    || !estimatedProviderId
    || !estimatedModelId
    || !Number.isSafeInteger(maxOutputUnits)
    || maxOutputUnits <= 0) {
    return error('cost_estimate_invalid', 'Cost estimate is invalid.', false, 503, origin, allowedOrigin);
  }
  let budget;
  try {
    budget = await bindingJson(env.BUDGET_GUARD, 'https://budget.internal/authorize', {
      conversation_id: body.conversation_id,
      turn_id: body.turn_id,
      input_characters: body.input.content.length,
      context_characters: String(body.context || '').length,
      estimated_cost_micros: estimatedCostMicros,
      currency: estimate.payload?.currency || null,
    });
  } catch {
    return error('budget_guard_unavailable', 'Budget guard is unavailable.', true, 503, origin, allowedOrigin);
  }
  if (!budget.response.ok || budget.payload?.allowed !== true) {
    return error(
      'budget_limit',
      'Request is not authorized by the budget guard.',
      false,
      429,
      origin,
      allowedOrigin,
      { limit_reason: budget.payload?.reason || null },
    );
  }
  if (budget.payload?.duplicate === true) {
    return error(
      'duplicate_turn',
      'This turn was already authorized; the provider will not be called again.',
      false,
      409,
      origin,
      allowedOrigin,
      { previous_status: budget.payload?.status || null },
    );
  }
  const reservationId = budget.payload?.reservation_id;
  if (!reservationId) {
    return error('budget_reservation_invalid', 'Budget reservation is invalid.', false, 503, origin, allowedOrigin);
  }

  if (!env.TEXT_PROVIDER?.fetch) {
    await releaseReservation(env.BUDGET_GUARD, reservationId);
    return error('provider_not_configured', 'Text provider is not configured.', true, 503, origin, allowedOrigin);
  }
  let upstream;
  const providerRequest = {
    ...body,
    execution: {
      estimate_id: estimate.payload?.estimate_id || null,
      provider_id: estimatedProviderId,
      model_id: estimatedModelId,
      max_output_units: maxOutputUnits,
    },
  };
  try {
    upstream = await bindingJson(env.TEXT_PROVIDER, 'https://provider.internal/respond', providerRequest);
  } catch {
    return error('provider_outcome_unknown', 'Provider outcome is unknown; automatic retry is disabled.', false, 503, origin, allowedOrigin);
  }
  if (!upstream.response.ok) {
    if (upstream.payload?.error?.usage_incurred === false) {
      await releaseReservation(env.BUDGET_GUARD, reservationId);
    } else {
      await commitReservation(env.BUDGET_GUARD, reservationId, upstream.payload?.usage || null);
    }
    return error(
      upstream.payload?.error?.code || 'provider_error',
      upstream.payload?.error?.message || 'Text provider failed.',
      upstream.payload?.error?.retryable === true,
      upstream.response.status >= 400 ? upstream.response.status : 502,
      origin,
      allowedOrigin,
    );
  }

  const actualProviderId = String(upstream.payload?.provider?.id || '').trim();
  const actualModelId = String(upstream.payload?.provider?.model || '').trim();
  const outputUnits = Number(upstream.payload?.usage?.output_units);
  const identityMismatch = actualProviderId !== estimatedProviderId || actualModelId !== estimatedModelId;
  const outputLimitExceeded = Number.isFinite(outputUnits) && outputUnits > maxOutputUnits;
  if (upstream.payload?.schema_version !== TEXT_GATEWAY_SCHEMA_VERSION
    || upstream.payload?.turn_id !== body.turn_id
    || identityMismatch
    || outputLimitExceeded) {
    await commitReservation(env.BUDGET_GUARD, reservationId, upstream.payload?.usage || null);
    return error('provider_response_invalid', 'Text provider returned an invalid response.', true, 502, origin, allowedOrigin);
  }
  const budgetStatus = await commitReservation(
    env.BUDGET_GUARD, reservationId, upstream.payload.usage || null);
  return json({
    ...upstream.payload,
    gateway_budget: { status: budgetStatus, warning: budget.payload?.warning || null },
  }, 200, origin, allowedOrigin);
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
