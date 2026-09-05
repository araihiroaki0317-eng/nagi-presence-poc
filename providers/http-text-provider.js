import {
  createTextGatewayRequest,
  errorFromGateway,
  parseTextGatewayResponse,
  TextGatewayError,
} from '../gateway/text-protocol.js';
import { transcriptContext } from '../runtime/transcript.js';

export function normalizeGatewayUrl(value) {
  const url = String(value || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('gateway_url_required');
  if (!/^(https:\/\/|http:\/\/localhost(?::\d+)?(?:\/|$)|\/)/.test(url)) {
    throw new Error('gateway_url_must_be_https_or_local');
  }
  return url;
}

async function readPayload(response) {
  try { return await response.json(); }
  catch { return null; }
}

export class HttpTextConversationProvider {
  constructor({ gatewayUrl, accessTokenProvider, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch_required');
    this.id = 'gateway-text';
    this.capabilities = Object.freeze({
      textInput: true,
      audioInput: false,
      textOutput: true,
      audioOutput: false,
      interruptible: true,
      usageEvents: true,
    });
    this.gatewayUrl = normalizeGatewayUrl(gatewayUrl);
    if (typeof accessTokenProvider !== 'function') throw new Error('access_token_provider_required');
    this.accessTokenProvider = accessTokenProvider;
    this.fetchImpl = fetchImpl;
    this.emit = null;
    this.context = '';
    this.history = [];
    this.conversationId = null;
    this.pending = new Map();
  }

  async connect({ context = '', route, emit, conversationId } = {}) {
    if (this.emit) throw new Error('provider_already_connected');
    if (typeof emit !== 'function') throw new Error('provider_emit_required');
    if (route?.inputChannel !== 'text' || !route?.outputChannels?.includes('text')) {
      throw new Error('gateway_text_route_required');
    }
    this.emit = emit;
    this.context = String(context || '');
    this.history = [];
    this.conversationId = String(conversationId || '').trim();
    if (!this.conversationId) throw new Error('conversation_id_required');
    return { sessionId: null };
  }

  async sendTurn({ turnId, input } = {}) {
    if (!this.emit) throw new Error('provider_not_connected');
    if (this.pending.has(turnId)) throw new Error('turn_already_pending');

    const request = createTextGatewayRequest({
      conversationId: this.conversationId,
      turnId,
      context: [this.context, transcriptContext(this.history)].filter(Boolean).join('\n\n'),
      input,
    });
    const controller = new AbortController();
    this.pending.set(turnId, controller);
    this.emit({ type: 'response.started', turn_id: turnId });

    try {
      const accessToken = String(await this.accessTokenProvider() || '').trim();
      if (!accessToken || /\s/.test(accessToken)) {
        throw new TextGatewayError('device_token_required', 'A valid device token is required.', {
          retryable: false,
        });
      }
      controller.signal.throwIfAborted();
      const response = await this.fetchImpl(`${this.gatewayUrl}/v1/text/respond`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const payload = await readPayload(response);
      if (!response.ok) throw errorFromGateway(response.status, payload);
      const result = parseTextGatewayResponse(payload, turnId);
      this.history.push(
        { role: 'user', text: String(input.content) },
        { role: 'agent', text: result.text },
      );
      this.history = this.history.slice(-8);
      if (result.usage) {
        this.emit({ type: 'usage', turn_id: turnId, payload: result.usage });
      }
      if (result.gatewayBudget?.warning?.level === 'soft_limit') {
        this.emit({
          type: 'budget.soft_limit',
          turn_id: turnId,
          payload: result.gatewayBudget.warning,
        });
      }
      this.emit({
        type: 'response.completed',
        turn_id: turnId,
        payload: { text: result.text, provider: result.provider },
      });
    } catch (error) {
      const interrupted = error?.name === 'AbortError';
      const normalized = interrupted
        ? new TextGatewayError('turn_interrupted', 'Turn interrupted.', { retryable: true })
        : error;
      this.emit?.({
        type: 'response.failed',
        turn_id: turnId,
        payload: {
          error: normalized?.message || String(normalized),
          code: normalized?.code || 'gateway_request_failed',
          retryable: normalized?.retryable === true,
        },
      });
      throw normalized;
    } finally {
      this.pending.delete(turnId);
    }
  }

  updateContext(value) {
    this.context = String(value || '');
  }

  interrupt({ turnId } = {}) {
    const controller = this.pending.get(turnId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async disconnect() {
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
    this.emit = null;
    this.conversationId = null;
  }
}
