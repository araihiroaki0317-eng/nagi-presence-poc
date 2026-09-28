export class RealtimeVoiceInput {
  constructor({ connect }) {
    if (typeof connect !== 'function') throw new Error('voice_input_connect_required');
    this.connect = connect;
    this.session = null;
    this.onTranscript = null;
    this.onError = null;
  }

  get active() {
    return Boolean(this.session);
  }

  async start({ onTranscript, onError } = {}) {
    if (this.session) throw new Error('voice_input_already_started');
    if (typeof onTranscript !== 'function') throw new Error('voice_input_transcript_handler_required');
    this.onTranscript = onTranscript;
    this.onError = onError;
    const session = await this.connect({
      onPartial: text => this.emit(text, false),
      onFinal: text => this.emit(text, true),
      onError: error => this.onError?.(error),
    });
    if (!session?.close) throw new Error('voice_input_session_invalid');
    this.session = session;
    return session;
  }

  emit(text, final) {
    const value = String(text || '').trim();
    if (!value) return;
    this.onTranscript?.({ text: value, final: Boolean(final) });
  }

  async stop() {
    const session = this.session;
    this.session = null;
    this.onTranscript = null;
    this.onError = null;
    if (session?.close) await session.close();
  }
}
