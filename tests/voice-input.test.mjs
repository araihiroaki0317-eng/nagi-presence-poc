import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeVoiceInput } from '../runtime/voice-input.js';

test('voice input forwards partial and final transcripts without provider coupling', async () => {
  const seen = [];
  let hooks;
  let closed = false;
  const input = new RealtimeVoiceInput({
    connect: async callbacks => {
      hooks = callbacks;
      return { async close() { closed = true; } };
    },
  });
  await input.start({ onTranscript: event => seen.push(event) });
  hooks.onPartial('  こん ');
  hooks.onFinal(' こんにちは ');
  assert.deepEqual(seen, [
    { text: 'こん', final: false },
    { text: 'こんにちは', final: true },
  ]);
  await input.stop();
  assert.equal(closed, true);
  assert.equal(input.active, false);
});

test('voice input reports provider errors without fabricating transcripts', async () => {
  const errors = [];
  let hooks;
  const input = new RealtimeVoiceInput({
    connect: async callbacks => {
      hooks = callbacks;
      return { async close() {} };
    },
  });
  await input.start({ onTranscript() {}, onError: error => errors.push(error.message) });
  hooks.onError(new Error('stt_down'));
  assert.deepEqual(errors, ['stt_down']);
  await input.stop();
});
