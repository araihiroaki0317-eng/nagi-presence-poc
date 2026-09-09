import test from 'node:test';
import assert from 'node:assert/strict';
import { ATTENTION_AUDIO_ASSET, createAttentionAudioPlayer } from '../runtime/attention-audio.js';

function fixture({ fetchImpl, resumeError, startError } = {}) {
  const calls = [];
  let context;
  class Context {
    state = 'suspended';
    destination = {};
    constructor() { context = this; calls.push('construct'); }
    resume() {
      calls.push('resume');
      if (resumeError) return Promise.reject(new Error(resumeError));
      this.state = 'running';
      return Promise.resolve();
    }
    async decodeAudioData() { calls.push('decode'); return { clip: true }; }
    createBufferSource() {
      calls.push('source');
      return {
        connect() {}, disconnect() {},
        start() { if (startError) throw new Error(startError); calls.push('start'); },
      };
    }
  }
  const player = createAttentionAudioPlayer({ AudioContextCtor: Context,
    fetchImpl: fetchImpl || (async src => {
      calls.push(src);
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) };
    }), preparationTimeoutMs: 20,
  });
  return { player, calls, get context() { return context; } };
}

test('dedicated clip matches the committed asset', () => {
  assert.equal(ATTENTION_AUDIO_ASSET, './assets/nagi_ack_v02_b_un.mp3');
});

test('resume happens synchronously in the gesture, without early audio', async () => {
  const { player, calls } = fixture();
  const ready = player.prepare();
  assert.deepEqual(calls, ['construct', 'resume']);
  assert.deepEqual(await ready, { ok: true });
  assert.ok(!calls.includes('start'));
  assert.deepEqual(await player.play(), { ok: true });
  assert.equal(calls.at(-1), 'start');
});

test('repeated wakes reuse decoded audio and resume an interrupted context', async () => {
  const f = fixture();
  await f.player.prepare();
  await f.player.play();
  f.context.state = 'suspended';
  assert.equal((await f.player.play()).reason, 'audio_not_running');
  await f.player.prepare();
  await f.player.play();
  assert.equal(f.calls.filter(x => x === 'construct').length, 1);
  assert.equal(f.calls.filter(x => x === 'decode').length, 1);
  assert.equal(f.calls.filter(x => x === 'resume').length, 2);
});

test('slow loading skips the cue and never starts it later', async () => {
  let release;
  const f = fixture({ fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const ready = f.player.prepare();
  await Promise.resolve();
  assert.equal((await f.player.play()).reason, 'audio_not_ready');
  release({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
  await ready;
  assert.ok(!f.calls.includes('start'));
});

test('permission refusal is contained and does not play', async () => {
  const f = fixture({ resumeError: 'NotAllowedError' });
  assert.equal((await f.player.prepare()).reason, 'prepare_failed');
  assert.equal((await f.player.play()).message, 'NotAllowedError');
  assert.ok(!f.calls.includes('start'));
});

test('missing asset is reported; next gesture can retry', async () => {
  let attempt = 0;
  const f = fixture({ fetchImpl: async () => ++attempt === 1
    ? { ok: false, status: 404 }
    : { ok: true, arrayBuffer: async () => new ArrayBuffer(1) } });
  assert.equal((await f.player.prepare()).message, 'Audio asset HTTP 404');
  assert.equal((await f.player.play()).reason, 'prepare_failed');
  assert.deepEqual(await f.player.prepare(), { ok: true });
});

test('a stalled preparation has a bounded lifetime', async () => {
  const f = fixture({ fetchImpl: () => new Promise(() => {}) });
  assert.equal((await f.player.prepare()).message, 'Audio preparation timed out');
  assert.equal((await f.player.play()).reason, 'prepare_failed');
});

test('unsupported Web Audio fails without a provider fallback', async () => {
  const player = createAttentionAudioPlayer({ AudioContextCtor: null });
  assert.equal((await player.prepare()).reason, 'audio_unavailable');
  assert.equal((await player.play()).reason, 'audio_unavailable');
});

test('source start failure is contained', async () => {
  const f = fixture({ startError: 'interrupted' });
  await f.player.prepare();
  assert.deepEqual(await f.player.play(), { ok: false, reason: 'play_failed', message: 'interrupted' });
});
