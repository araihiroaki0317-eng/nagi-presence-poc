import { normalizeChannelRoute } from './channel-route.js';

const CONVERSATION_STATUSES = new Set(['new', 'active', 'paused', 'closed']);

function fallbackId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function createId(prefix) {
  return globalThis.crypto?.randomUUID?.() || fallbackId(prefix);
}

function assertProvider(provider) {
  if (!provider?.id) throw new Error('provider_id_required');
  for (const method of ['connect', 'sendTurn', 'disconnect']) {
    if (typeof provider[method] !== 'function') throw new Error(`provider_${method}_required`);
  }
}

function assertCapabilities(provider, route) {
  const capabilities = provider.capabilities || {};
  if (route.inputChannel === 'text' && capabilities.textInput === false) {
    throw new Error('provider_text_input_unsupported');
  }
  if (route.inputChannel === 'audio' && capabilities.audioInput === false) {
    throw new Error('provider_audio_input_unsupported');
  }
  if (route.outputChannels.includes('text') && capabilities.textOutput === false) {
    throw new Error('provider_text_output_unsupported');
  }
  if (route.outputChannels.includes('audio') && capabilities.audioOutput === false) {
    throw new Error('provider_audio_output_unsupported');
  }
}

export class ConversationCore {
  constructor({ provider, eventSink = () => {}, idFactory = createId, now = () => new Date().toISOString() }) {
    assertProvider(provider);
    this.provider = provider;
    this.eventSink = eventSink;
    this.idFactory = idFactory;
    this.now = now;
    this.listeners = new Set();
    this.value = {
      conversation_id: null,
      conversation_status: 'new',
      active_turn_id: null,
      input_channel: 'text',
      output_channels: ['text'],
      provider_route: provider.id,
      provider_session_id: null,
      fallback_status: 'none',
      latest_checkpoint_id: null,
      pending_input: null,
    };
  }

  get active() {
    return this.value.conversation_status === 'active';
  }

  snapshot() {
    return structuredClone(this.value);
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new Error('listener_required');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _emit(type, fields = {}) {
    const event = Object.freeze({
      ...fields,
      type,
      timestamp: this.now(),
      conversation_id: this.value.conversation_id,
      provider_id: this.provider.id,
      input_channel: this.value.input_channel,
      output_channels: [...this.value.output_channels],
    });
    try {
      const pending = this.eventSink(event);
      pending?.catch?.(() => {});
    } catch {}
    for (const listener of this.listeners) {
      try { listener(event); } catch {}
    }
    return event;
  }

  async start({ context = '', route = {} } = {}) {
    if (this.value.conversation_status === 'closed') throw new Error('conversation_closed');
    if (this.active) throw new Error('conversation_already_started');

    const normalizedRoute = normalizeChannelRoute(route);
    assertCapabilities(this.provider, normalizedRoute);
    const isResume = this.value.conversation_status === 'paused';
    if (!this.value.conversation_id) this.value.conversation_id = this.idFactory('conv');
    this.value.input_channel = normalizedRoute.inputChannel;
    this.value.output_channels = [...normalizedRoute.outputChannels];
    this._emit('provider_connect_started', { resumed: isResume });

    try {
      const connection = await this.provider.connect({
        context,
        route: normalizedRoute,
        conversationId: this.value.conversation_id,
        emit: event => this.receiveProviderEvent(event),
      });
      this.value.provider_session_id = connection?.sessionId || null;
      this.value.conversation_status = 'active';
      this._emit('provider_connected', { provider_session_id: this.value.provider_session_id });
      this._emit(isResume ? 'logical_conversation_resumed' : 'logical_conversation_started');
      return this.snapshot();
    } catch (error) {
      this.value.conversation_status = isResume ? 'paused' : 'new';
      this._emit('provider_connect_failed', { error: error?.message || String(error) });
      throw error;
    }
  }

  async submitInput({ type = 'text', content, channel = this.value.input_channel } = {}) {
    if (!this.active) throw new Error('conversation_not_started');
    if (this.value.active_turn_id) throw new Error('turn_already_active');
    if (type !== 'text') throw new Error('input_type_not_implemented');
    const value = String(content || '').trim();
    if (!value) throw new Error('message_required');

    const turnId = this.idFactory('turn');
    const pendingInput = { type, content: value, channel };
    this.value.pending_input = pendingInput;
    this.value.active_turn_id = turnId;
    this._emit('turn_started', { turn_id: turnId, input_type: type, input_channel: channel });
    try {
      await this.provider.sendTurn({
        turnId,
        input: pendingInput,
      });
      return turnId;
    } catch (error) {
      this.value.active_turn_id = null;
      this.value.pending_input = pendingInput;
      this._emit('turn_failed', { turn_id: turnId, error: error?.message || String(error) });
      throw error;
    }
  }

  receiveProviderEvent(input = {}) {
    const event = {
      ...input,
      turn_id: input.turn_id || this.value.active_turn_id,
    };
    const terminal = event.type === 'response.completed' || event.type === 'response.failed';
    const isCurrentTurn = !event.turn_id || event.turn_id === this.value.active_turn_id;
    if (terminal && isCurrentTurn) {
      this.value.active_turn_id = null;
      if (event.type === 'response.completed') this.value.pending_input = null;
    }
    this._emit(event.type || 'provider.event', event);
  }

  updateContext(context) {
    const value = String(context || '').trim();
    if (!value) return;
    this.provider.updateContext?.(value);
    this._emit('context_updated', { context_length: value.length });
  }

  setCheckpoint(checkpointId) {
    const value = String(checkpointId || '').trim();
    if (!value) throw new Error('checkpoint_id_required');
    this.value.latest_checkpoint_id = value;
    this._emit('checkpoint_updated', { checkpoint_id: value });
    return this.snapshot();
  }

  async switchProvider({ provider, route, context = '', reason = 'route_fallback' } = {}) {
    assertProvider(provider);
    if (this.active) await this.pause(reason);
    this.provider = provider;
    this.value.provider_route = provider.id;
    this.value.fallback_status = 'active';
    this._emit('provider_route_changed', { reason, provider_route: provider.id });
    return this.start({ context, route });
  }

  async retryPendingInput() {
    const pending = this.value.pending_input;
    if (!pending) return null;
    this.value.pending_input = null;
    return this.submitInput(pending);
  }

  async pause(reason = 'manual_pause') {
    if (!this.active) return this.snapshot();
    await this.provider.disconnect({ reason });
    this.value.provider_session_id = null;
    this.value.active_turn_id = null;
    this.value.conversation_status = 'paused';
    this._emit('provider_disconnected', { reason });
    this._emit('logical_conversation_paused', { reason });
    return this.snapshot();
  }

  async close(reason = 'manual_close') {
    if (this.active) await this.provider.disconnect({ reason });
    this.value.provider_session_id = null;
    this.value.active_turn_id = null;
    this.value.conversation_status = 'closed';
    this._emit('logical_conversation_closed', { reason });
    return this.snapshot();
  }
}

export function isConversationStatus(value) {
  return CONVERSATION_STATUSES.has(value);
}
