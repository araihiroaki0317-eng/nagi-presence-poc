import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTENTION_AUDIO_ASSET,
  createAttentionAudioPlayer,
} from '../runtime/attention-audio.js';

test('attention acknowledgement uses a dedicated local audio asset', () => {
  assert.equal(ATTENTION_AUDIO_ASSET, './assets/nagi_ack_un.mp3');
});

test('audio player reports unavailable when Audio is not present', async () => {
  const player = createAttentionAudioPlayer({ AudioCtor: undefined });
  assert.deepEqual(await player.play(), { ok: false, reason: 'audio_unavailable' });
});

test('audio player plays injected clip without provider dependency', async () => {
  const calls = [];
  class FakeAudio {
    constructor(src) {
      calls.push(['construct', src]);
      this.preload = '';
      this.currentTime = 9;
    }
    async play() {
      calls.push(['play', this.currentTime, this.preload]);
    }
  }

  const player = createAttentionAudioPlayer({ AudioCtor: FakeAudio });
  assert.deepEqual(await player.play(), { ok: true });
  assert.deepEqual(calls, [
    ['construct', './assets/nagi_ack_un.mp3'],
    ['play', 0, 'auto'],
  ]);
});

test('audio playback failure is contained and returned as data', async () => {
  class BrokenAudio {
    constructor() {
      this.preload = '';
      this.currentTime = 0;
    }
    async play() {
      throw new Error('blocked');
    }
  }

  const player = createAttentionAudioPlayer({ AudioCtor: BrokenAudio });
  assert.deepEqual(await player.play(), {
    ok: false,
    reason: 'play_failed',
    message: 'blocked',
  });
});
