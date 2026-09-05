export class MockConversationProvider {
  constructor({ delayMs = 240, scheduler = setTimeout } = {}) {
    this.id = 'mock';
    this.capabilities = Object.freeze({
      textInput: true,
      audioInput: true,
      textOutput: true,
      audioOutput: true,
      interruptible: true,
      usageEvents: false,
    });
    this.delayMs = delayMs;
    this.scheduler = scheduler;
    this.emit = null;
    this.sequence = 0;
    this.context = '';
  }

  async connect({ context = '', emit } = {}) {
    if (this.emit) throw new Error('provider_already_connected');
    if (typeof emit !== 'function') throw new Error('provider_emit_required');
    this.emit = emit;
    this.context = context;
    return { sessionId: `mock_session_${++this.sequence}` };
  }

  async sendTurn({ turnId, input } = {}) {
    if (!this.emit) throw new Error('provider_not_connected');
    const value = String(input?.content || '').trim();
    if (!value) throw new Error('message_required');
    const emit = this.emit;
    emit({ type: 'response.started', turn_id: turnId });
    this.scheduler(() => {
      if (emit !== this.emit) return;
      emit({
        type: 'response.completed',
        turn_id: turnId,
        payload: { text: `モックで受け取りました。「${value}」` },
      });
    }, this.delayMs);
  }

  updateContext(value) {
    this.context = String(value || '');
  }

  async disconnect() {
    this.emit = null;
  }
}
