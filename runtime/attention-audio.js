export const ATTENTION_AUDIO_ASSET = './assets/nagi_ack_v02_b_un.mp3';

export function createAttentionAudioPlayer({
  AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext,
  fetchImpl = globalThis.fetch,
  src = ATTENTION_AUDIO_ASSET,
  preparationTimeoutMs = 5000,
} = {}) {
  let context;
  let buffer;
  let pending;
  let failure;

  return {
    // Must be called directly from the submit handler, before any await/timer.
    // Resume authorizes the context; it does not play the acknowledgement early.
    prepare() {
      if (pending) return pending;
      if (typeof AudioContextCtor !== 'function' || typeof fetchImpl !== 'function') {
        failure = { ok: false, reason: 'audio_unavailable' };
        return Promise.resolve(failure);
      }
      let resume;
      try {
        context ||= new AudioContextCtor();
        resume = context.resume();
      } catch (error) {
        failure = { ok: false, reason: 'prepare_failed', message: String(error?.message || error) };
        return Promise.resolve(failure);
      }
      failure = undefined;
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Audio preparation timed out'));
        }, preparationTimeoutMs);
      });
      const load = buffer ? Promise.resolve(buffer) : Promise.resolve().then(async () => {
        const response = await fetchImpl(src, { signal: controller.signal });
        if (!response.ok) throw new Error(`Audio asset HTTP ${response.status}`);
        return context.decodeAudioData(await response.arrayBuffer());
      });
      pending = Promise.race([Promise.all([resume, load]), timeout])
        .then(([, decoded]) => {
          if (context.state !== 'running') throw new Error(`Audio context ${context.state}`);
          buffer = decoded;
          return { ok: true };
        })
        .catch(error => {
          failure = { ok: false, reason: 'prepare_failed', message: String(error?.message || error) };
          return failure;
        })
        .finally(() => {
          clearTimeout(timer);
          pending = undefined;
        });
      return pending;
    },

    async play() {
      // Never wait for loading here: a late acknowledgement would miss the motion.
      if (failure) return failure;
      if (pending || !buffer) return { ok: false, reason: 'audio_not_ready' };
      if (context.state !== 'running') return { ok: false, reason: 'audio_not_running' };
      try {
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.onended = () => source.disconnect();
        source.start();
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: 'play_failed', message: String(error?.message || error) };
      }
    },
  };
}
