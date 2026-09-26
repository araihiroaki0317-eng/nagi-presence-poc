export class TtsOutputAdapter {
  constructor({ synthesize, playAudio }) {
    if (typeof synthesize !== 'function') throw new Error('tts_synthesize_required');
    if (typeof playAudio !== 'function') throw new Error('tts_player_required');
    this.synthesize = synthesize;
    this.playAudio = playAudio;
  }

  async speak(text, { signal } = {}) {
    const value = String(text || '').trim();
    if (!value) return { ok: false, reason: 'tts_text_required' };
    try {
      const audio = await this.synthesize(value, { signal });
      if (signal?.aborted) return { ok: false, reason: 'tts_aborted' };
      await this.playAudio(audio, { signal });
      return { ok: true };
    } catch (error) {
      if (signal?.aborted) return { ok: false, reason: 'tts_aborted' };
      return { ok: false, reason: 'tts_failed', message: String(error?.message || error) };
    }
  }
}

export function createWorkerTtsSynthesizer({
  endpoint,
  fetchImpl = globalThis.fetch?.bind(globalThis),
} = {}) {
  const base = String(endpoint || '').replace(/\/+$/, '');
  if (!base) throw new Error('tts_endpoint_required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch_required');

  return async (text, { signal } = {}) => {
    const response = await fetchImpl(`${base}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!response.ok) throw new Error(`tts_backend_http_${response.status}`);
    return response.blob();
  };
}
