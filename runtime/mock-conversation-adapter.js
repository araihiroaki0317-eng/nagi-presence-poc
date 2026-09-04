import { ConversationCore } from './conversation-core.js';
import { MockConversationProvider } from '../providers/mock-provider.js';
import { routeForProfile as defaultRouteForProfile } from './conversation-profile.js';

export class MockConversationAdapter {
  constructor({ routeForProfile = defaultRouteForProfile, eventSink = () => {}, provider = new MockConversationProvider() } = {}) {
    if (typeof routeForProfile !== 'function') throw new Error('route_for_profile_required');
    this.routeForProfile = routeForProfile;
    this.callbacks = null;
    this.profile = null;
    this.core = new ConversationCore({ provider, eventSink });
    this.core.subscribe(event => this.handleCoreEvent(event));
  }

  get active() {
    return this.core.active;
  }

  async start(profile, callbacks = {}) {
    if (this.active) throw new Error('conversation_already_started');
    this.profile = profile;
    this.callbacks = callbacks;
    await this.core.start({ route: this.routeForProfile(profile) });
    callbacks.onStatusChange?.({ status: 'connected' });
    callbacks.onConnect?.();
    callbacks.onModeChange?.({ mode: 'listening' });
    return this;
  }

  handleCoreEvent(event) {
    if (!this.callbacks) return;
    if (event.type === 'response.started') {
      this.callbacks.onModeChange?.({ mode: 'speaking' });
    }
    if (event.type === 'response.completed') {
      const text = event.payload?.text || '';
      if (text) this.callbacks.onMessage?.({ source: 'ai', message: text, final: true });
      this.callbacks.onModeChange?.({ mode: 'listening' });
    }
    if (event.type === 'response.failed') {
      this.callbacks.onError?.(new Error(event.payload?.error || 'mock_response_failed'));
    }
    if (event.type === 'budget.soft_limit') {
      this.callbacks.onBudget?.(event);
    }
  }

  sendText(text) {
    const value = String(text || '').trim();
    if (!this.active) throw new Error('conversation_not_started');
    if (!value) throw new Error('message_required');
    this.callbacks?.onMessage?.({ source: 'user', message: value, final: true });
    return this.core.submitInput({ type: 'text', content: value, channel: 'text' });
  }

  sendActivity() {}

  sendContext(text) {
    this.core.updateContext(text);
  }

  async switchToTextFallback({ provider = new MockConversationProvider(), context = '' } = {}) {
    this.profile = 'text_silent';
    await this.core.switchProvider({
      provider,
      route: this.routeForProfile(this.profile),
      context,
      reason: 'voice_budget_hard_limit',
    });
    this.callbacks?.onStatusChange?.({ status: 'connected', route: provider.id });
    this.callbacks?.onModeChange?.({ mode: 'listening' });
    await this.core.retryPendingInput();
    return this;
  }

  getId() {
    return this.core.snapshot().conversation_id;
  }

  async end() {
    const callbacks = this.callbacks;
    await this.core.pause('adapter_end');
    this.profile = null;
    this.callbacks = null;
    callbacks?.onStatusChange?.({ status: 'disconnected' });
    callbacks?.onDisconnect?.({ reason: 'mock_session_ended' });
  }
}
