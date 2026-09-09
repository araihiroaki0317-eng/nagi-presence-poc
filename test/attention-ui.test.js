import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createAttentionAcknowledgement, ATTENTION_ACKNOWLEDGEMENT, ATTENTION_SEQUENCE } from '../runtime/attention.js';

test('typed wake prepares audio in submit, then plays only after 1650ms', async () => {
  const calls = [];
  const timers = [];
  let submit;
  const input = { value: '凪', style: {} };
  const composer = { addEventListener(name, fn) { submit = fn; } };
  const script = readFileSync(new URL('../runtime/attention-ui.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '');
  vm.runInNewContext(script, {
    ATTENTION_ACKNOWLEDGEMENT, ATTENTION_SEQUENCE, createAttentionAcknowledgement,
    createAttentionAudioPlayer: () => ({
      prepare() { calls.push('prepare'); return Promise.resolve({ ok: true }); },
      async play() { calls.push('play'); return { ok: true }; },
    }),
    runtimeEvent: async () => { calls.push('log'); },
    LocalTranscriptStore: class { append(turn) { return { duplicate: false, turn }; } },
    document: { getElementById: id => id === 'composer' ? composer : id === 'textInput' ? input : null },
    setTimeout(fn, ms) { timers.push({ fn, ms }); },
    clearTimeout() {},
  });
  const event = { preventDefault() {}, stopImmediatePropagation() {} };
  input.value = '今日はどう？';
  submit(event);
  assert.deepEqual(calls, []);
  input.value = '凪';
  submit(event);
  assert.equal(calls[0], 'prepare');
  assert.ok(!calls.includes('play'));
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const cue = timers.find(t => t.ms === 1650);
  assert.ok(cue, 'the cue delay remains 1650ms');
  assert.ok(!calls.includes('play'));
  cue.fn();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(calls.filter(x => x === 'play').length, 1);
});
