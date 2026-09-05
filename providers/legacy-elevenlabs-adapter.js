import {
  assertConversationProfile,
  CONVERSATION_PROFILES,
  sessionOptionsFor,
} from '../runtime/conversation-profile.js';

const DEFAULT_SDK_URL = 'https://esm.sh/@elevenlabs/client@latest?bundle';

export class LegacyElevenLabsConversationAdapter {
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
    assertConversationProfile(profile);
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

export class LazyElevenLabsConversationAdapter {
  constructor({
    agentId,
    mediaDevices = globalThis.navigator?.mediaDevices,
    sdkLoader = () => import(DEFAULT_SDK_URL),
  } = {}) {
    if (!agentId) throw new Error('agent_id_required');
    if (typeof sdkLoader !== 'function') throw new Error('sdk_loader_required');
    this.agentId = agentId;
    this.mediaDevices = mediaDevices;
    this.sdkLoader = sdkLoader;
    this.delegate = null;
    this.loading = null;
  }

  get active() {
    return Boolean(this.delegate?.active);
  }

  async loadDelegate() {
    if (this.delegate) return this.delegate;
    if (!this.loading) {
      this.loading = Promise.resolve(this.sdkLoader())
        .then(module => {
          const Conversation = module?.Conversation || module?.default?.Conversation;
          this.delegate = new LegacyElevenLabsConversationAdapter({
            Conversation,
            agentId: this.agentId,
            mediaDevices: this.mediaDevices,
          });
          return this.delegate;
        })
        .finally(() => { this.loading = null; });
    }
    return this.loading;
  }

  async start(profile, callbacks = {}) {
    assertConversationProfile(profile);
    const delegate = await this.loadDelegate();
    return delegate.start(profile, callbacks);
  }

  sendText(text) {
    if (!this.delegate) throw new Error('conversation_not_started');
    return this.delegate.sendText(text);
  }

  sendActivity() {
    return this.delegate?.sendActivity();
  }

  sendContext(text) {
    return this.delegate?.sendContext(text);
  }

  getId() {
    return this.delegate?.getId() || null;
  }

  async end() {
    return this.delegate?.end();
  }
}
