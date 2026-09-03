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

export class ElevenLabsConversationAdapter {
  constructor({ Conversation, agentId, mediaDevices = globalThis.navigator?.mediaDevices }) {
    if (!Conversation?.startSession) throw new Error('conversation_sdk_required');
    if (!agentId) throw new Error('agent_id_required');
    this.Conversation = Conversation;
    this.agentId = agentId;
    this.mediaDevices = mediaDevices;
    this.session = null;
    this.profile = null;
  }

  get active() {
    return Boolean(this.session);
  }

  async start(profile, callbacks = {}) {
    assertProfile(profile);
    if (this.session) throw new Error('conversation_already_started');

    if (profile === CONVERSATION_PROFILES.VOICE) {
      if (!this.mediaDevices?.getUserMedia) throw new Error('microphone_unavailable');
      const stream = await this.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
    }

    const options = sessionOptionsFor(profile, callbacks);
    this.session = await this.Conversation.startSession({ agentId: this.agentId, ...options });
    this.profile = profile;

    if (profile === CONVERSATION_PROFILES.TEXT_AUDIO && this.session?.setMicMuted) {
      this.session.setMicMuted(true);
    }
    return this.session;
  }

  sendText(text) {
    const value = String(text || '').trim();
    if (!this.session) throw new Error('conversation_not_started');
    if (!value) throw new Error('message_required');
    this.session.sendUserMessage(value);
  }

  sendActivity() {
    this.session?.sendUserActivity?.();
  }

  sendContext(text) {
    if (text) this.session?.sendContextualUpdate?.(text);
  }

  getId() {
    return this.session?.getId?.() || null;
  }

  async end() {
    const session = this.session;
    this.session = null;
    this.profile = null;
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
    callbacks.onModeChange?.({ mode: 'speaking' });
    setTimeout(() => {
      if (!this.active || callbacks !== this.callbacks) return;
      callbacks.onMessage?.({ source: 'ai', message: response, final: true });
      callbacks.onModeChange?.({ mode: 'listening' });
    }, 240);
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
