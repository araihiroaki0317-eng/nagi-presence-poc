import test from 'node:test';
import assert from 'node:assert/strict';
import { TtsOutputAdapter, createWorkerTtsSynthesizer } from '../runtime/tts-output-adapter.js';

test('TTS uses the exact response text and waits for playback', async () => {
  const calls = [];
  const tts = new TtsOutputAdapter({
    async synthesize(text) { calls.push(['synthesize', text]); return { audio: true }; },
    async playAudio(audio) { calls.push(['play', audio]); },
  });
  assert.deepEqual(await tts.speak('凪の返答'), { ok: true });
  assert.deepEqual(calls, [['synthesize', '凪の返答'], ['play', { audio: true }]]);
});

test('TTS failure is contained so text conversation can continue', async () => {
  const tts = new TtsOutputAdapter({
    async synthesize() { throw new Error('provider_down'); },
    async playAudio() { throw new Error('should_not_play'); },
  });
  assert.deepEqual(await tts.speak('文字は残る'), {
    ok: false, reason: 'tts_failed', message: 'provider_down',
  });
});

test('Worker synthesizer sends text without exposing provider credentials', async () => {
  const requests = [];
  const synthesize = createWorkerTtsSynthesizer({
    endpoint: 'https://voice.example/',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(new Blob(['audio']), { status: 200 });
    },
  });
  await synthesize('同じ返答');
  assert.equal(requests[0].url, 'https://voice.example/tts');
  assert.deepEqual(JSON.parse(requests[0].options.body), { text: '同じ返答' });
  assert.equal(requests[0].options.headers['xi-api-key'], undefined);
});
