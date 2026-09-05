export const TEXT_GATEWAY_SCHEMA_VERSION = '0.1';

function requiredString(value, errorCode) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(errorCode);
  return normalized;
}

export function createTextGatewayRequest({ conversationId, turnId, context = '', input } = {}) {
  return {
    schema_version: TEXT_GATEWAY_SCHEMA_VERSION,
    conversation_id: requiredString(conversationId, 'conversation_id_required'),
    turn_id: requiredString(turnId, 'turn_id_required'),
    context: String(context || ''),
    input: {
      type: 'text',
      content: requiredString(input?.content, 'message_required'),
      channel: input?.channel || 'text',
    },
    output_channels: ['text'],
  };
}

export function parseTextGatewayResponse(payload, expectedTurnId) {
  if (!payload || typeof payload !== 'object') throw new Error('gateway_response_invalid');
  if (payload.schema_version !== TEXT_GATEWAY_SCHEMA_VERSION) {
    throw new Error('gateway_schema_unsupported');
  }
  if (payload.turn_id !== expectedTurnId) throw new Error('gateway_turn_mismatch');
  const text = requiredString(payload.output?.text, 'gateway_text_missing');
  return {
    text,
    provider: payload.provider || null,
    usage: payload.usage || null,
    gatewayBudget: payload.gateway_budget || null,
  };
}

export class TextGatewayError extends Error {
  constructor(code, message, { status = null, retryable = false, limitReason = null } = {}) {
    super(message || code || 'gateway_error');
    this.name = 'TextGatewayError';
    this.code = code || 'gateway_error';
    this.status = status;
    this.retryable = Boolean(retryable);
    this.limitReason = limitReason;
  }
}

export function errorFromGateway(status, payload) {
  const error = payload?.error || {};
  return new TextGatewayError(
    error.code || `gateway_http_${status}`,
    error.message || 'Text gateway request failed.',
    { status, retryable: error.retryable === true, limitReason: error.limit_reason || null },
  );
}
