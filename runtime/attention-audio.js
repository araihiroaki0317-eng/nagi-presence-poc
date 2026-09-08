export const ATTENTION_AUDIO_ASSET = './assets/nagi_ack_v02_b_un.mp3';

export function createAttentionAudioPlayer({ AudioCtor = globalThis.Audio, src = ATTENTION_AUDIO_ASSET } = {}) {
  return {
    async play() {
      if (typeof AudioCtor !== 'function') {
        return { ok: false, reason: 'audio_unavailable' };
      }

      let audio;
      try {
        audio = new AudioCtor(src);
        audio.preload = 'auto';
        audio.currentTime = 0;
        await audio.play();
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: 'play_failed',
          message: error?.message || String(error),
        };
      }
    },
  };
}
