export const CONVERSATION_PROFILES = Object.freeze({
  VOICE: 'voice',
  TEXT_AUDIO: 'text_audio',
  TEXT_SILENT: 'text_silent',
});

const VALID_PROFILES = new Set(Object.values(CONVERSATION_PROFILES));

function assertProfile(profile) {
  if (!VALID_PROFILES.has(profile)) throw new Error('invalid_conversation_profile');
}

export function sessionOptionsFor(profile, callbacks = {}) {
  assertProfile(profile);
  const textOnly = profile === CONVERSATION_PROFILES.TEXT_SILENT;
  return {
    ...callbacks,
    connectionType: textOnly ? 'websocket' : 'webrtc',
    textOnly,
    micMuted: profile === CONVERSATION_PROFILES.TEXT_AUDIO,
    ...(textOnly ? { overrides: { conversation: { textOnly: true } } } : {}),
  };
}

export function memoryConfigFromLocation(search = globalThis.location?.search || '') {
  const params = new URLSearchParams(search);
  const enabled = params.get('backend') === 'memory';
  const endpoint = String(params.get('memoryApi') || '').replace(/\/+$/, '');
  return {
    enabled,
    endpoint,
    userId: params.get('memoryUser') || 'nagi-poc-test',
    threadId: params.get('memoryThread') || 'nagi-poc-002',
  };
}

export class ElevenLabsConversationAdapter {
  constructor({
    Conversation,
    agentId,
    mediaDevices = globalThis.navigator?.mediaDevices,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    memoryConfig = memoryConfigFromLocation(),
  }) {
    if (!Conversation?.startSession) throw new Error('conversation_sdk_required');
    if (!agentId) throw new Error('agent_id_required');
    this.Conversation = Conversation;
    this.agentId = agentId;
    this.mediaDevices = mediaDevices;
    this.fetchImpl = fetchImpl;
    this.memoryConfig = memoryConfig;
    this.session = null;
    this.profile = null;
    this.callbacks = null;
    this.memorySequence = 0;
  }

  get active() {
    return Boolean(this.session);
  }

  get memoryMode() {
    return Boolean(this.memoryConfig?.enabled && this.profile === CONVERSATION_PROFILES.TEXT_SILENT);
  }

  async start(profile, callbacks = {}) {
    assertProfile(profile);
    if (this.session) throw new Error('conversation_already_started');

    if (this.memoryConfig?.enabled && profile === CONVERSATION_PROFILES.TEXT_SILENT) {
      if (!this.memoryConfig.endpoint) throw new Error('memory_endpoint_required');
      if (!this.fetchImpl) throw new Error('fetch_required');
      this.profile = profile;
      this.callbacks = callbacks;
      const id = `memory_${++this.memorySequence}`;
      this.session = { kind: 'memory', id };
      queueMicrotask(() => {
        if (!this.session || this.session.id !== id) return;
        callbacks.onStatusChange?.({ status: 'connected', backend: 'memory' });
        callbacks.onConnect?.();
        callbacks.onModeChange?.({ mode: 'listening' });
      });
      return this.session;
    }

    if (profile === CONVERSATION_PROFILES.VOICE) {
      if (!this.mediaDevices?.getUserMedia) throw new Error('microphone_unavailable');
      const stream = await this.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
    }

    const options = sessionOptionsFor(profile, callbacks);
    this.session = await this.Conversation.startSession({ agentId: this.agentId, ...options });
    this.profile = profile;
    this.callbacks = callbacks;

    if (profile === CONVERSATION_PROFILES.TEXT_AUDIO && this.session?.setMicMuted) {
      this.session.setMicMuted(true);
    }
    return this.session;
  }

  sendText(text) {
    const value = String(text || '').trim();
    if (!this.session) throw new Error('conversation_not_started');
    if (!value) throw new Error('message_required');
    if (this.memoryMode) return this.sendMemoryText(value);
    this.session.sendUserMessage(value);
  }

  async sendMemoryText(value) {
    const callbacks = this.callbacks || {};
    const session = this.session;
    callbacks.onStatusChange?.({ status: 'processing', backend: 'memory' });
    try {
      const response = await this.fetchImpl(`${this.memoryConfig.endpoint}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: value,
          user_id: this.memoryConfig.userId,
          thread_id: this.memoryConfig.threadId,
          top_k: 5,
          threshold: 0.1,
        }),
      });
      let payload = null;
      try { payload = await response.json(); } catch { payload = null; }
      if (!response.ok) {
        const error = new Error(payload?.error || `memory_backend_http_${response.status}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      const reply = String(payload?.response || '').trim();
      if (!reply) throw new Error('memory_response_missing');
      if (this.session !== session) return;
      callbacks.onModeChange?.({ mode: 'speaking' });
      callbacks.onMessage?.({ source: 'ai', message: reply, final: true, backend: 'memory' });
      callbacks.onModeChange?.({ mode: 'listening' });
      callbacks.onStatusChange?.({ status: 'connected', backend: 'memory' });
      return payload;
    } catch (error) {
      if (this.session === session) {
        callbacks.onError?.(error);
        callbacks.onModeChange?.({ mode: 'listening' });
        callbacks.onStatusChange?.({ status: 'error', backend: 'memory' });
      }
      return { ok: false, error: error?.message || 'memory_backend_error' };
    }
  }

  sendActivity() {
    if (this.memoryMode) return;
    this.session?.sendUserActivity?.();
  }

  sendContext(text) {
    if (this.memoryMode) return;
    if (text) this.session?.sendContextualUpdate?.(text);
  }

  getId() {
    if (this.memoryMode) return this.session?.id || null;
    return this.session?.getId?.() || null;
  }

  async end() {
    const session = this.session;
    const callbacks = this.callbacks;
    const wasMemory = this.memoryMode;
    this.session = null;
    this.profile = null;
    this.callbacks = null;
    if (wasMemory) {
      callbacks?.onStatusChange?.({ status: 'disconnected', backend: 'memory' });
      callbacks?.onDisconnect?.({ reason: 'memory_session_ended' });
      return;
    }
    if (session?.endSession) await session.endSession();
  }
}

export class MockConversationAdapter {
  constructor() {
    this.profile = null;
    this.callbacks = null;
    this.sequence = 0;
  }

  get active() {
    return Boolean(this.profile);
  }

  async start(profile, callbacks = {}) {
    assertProfile(profile);
    if (this.active) throw new Error('conversation_already_started');
    this.profile = profile;
    this.callbacks = callbacks;
    queueMicrotask(() => {
      callbacks.onStatusChange?.({ status: 'connected' });
      callbacks.onConnect?.();
      callbacks.onModeChange?.({ mode: 'listening' });
    });
    return this;
  }

  sendText(text) {
    const value = String(text || '').trim();
    if (!this.active) throw new Error('conversation_not_started');
    if (!value) throw new Error('message_required');
    const callbacks = this.callbacks;
    const response = `モックで受け取りました。「${value}」`;
    callbacks.onMessage?.({ source: 'user', message: value, final: true });

    // Verification-only pacing: keep the response transition visible on a real device.
    // Production provider timing is intentionally untouched.
    setTimeout(() => {
      if (!this.active || callbacks !== this.callbacks) return;
      callbacks.onModeChange?.({ mode: 'speaking' });
      setTimeout(() => {
        if (!this.active || callbacks !== this.callbacks) return;
        callbacks.onMessage?.({ source: 'ai', message: response, final: true });
        callbacks.onModeChange?.({ mode: 'listening' });
      }, 1600);
    }, 1400);
  }

  sendActivity() {}

  sendContext() {}

  getId() {
    return `mock_${++this.sequence}`;
  }

  async end() {
    const callbacks = this.callbacks;
    this.profile = null;
    this.callbacks = null;
    callbacks?.onStatusChange?.({ status: 'disconnected' });
    callbacks?.onDisconnect?.({ reason: 'mock_session_ended' });
  }
}
