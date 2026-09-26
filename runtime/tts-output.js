const DEFAULT_TTS_ENDPOINT = 'https://nagi-voice-transport.arai-hiroaki0317.workers.dev/tts';

export function createTtsOutput({ endpoint = DEFAULT_TTS_ENDPOINT, fetchImpl = globalThis.fetch?.bind(globalThis), AudioCtor = globalThis.Audio } = {}) {
  let currentAudio = null;
  let currentUrl = null;
  return {
    async speak(text) {
      const value = String(text || '').trim();
      if (!value || !fetchImpl || !AudioCtor) return { ok: false, error: 'tts_unavailable' };
      try {
        currentAudio?.pause?.();
        if (currentUrl) URL.revokeObjectURL(currentUrl);
        const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: value }) });
        if (!response.ok) return { ok: false, error: `tts_http_${response.status}` };
        const blob = await response.blob();
        currentUrl = URL.createObjectURL(blob);
        currentAudio = new AudioCtor(currentUrl);
        await currentAudio.play();
        await new Promise(resolve => {
          currentAudio.addEventListener('ended', resolve, { once: true });
          currentAudio.addEventListener('error', resolve, { once: true });
        });
        URL.revokeObjectURL(currentUrl);
        currentUrl = null;
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error?.message || 'tts_error' };
      }
    },
    stop() {
      currentAudio?.pause?.();
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      currentAudio = null;
      currentUrl = null;
    },
  };
}
