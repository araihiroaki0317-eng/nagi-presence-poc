import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveAttention } from '../runtime/live-attention.js';
test('idle drops ordinary speech, existing wake word acknowledges, conversation resumes and expires', () => {
  let time = 100;
  const gate = createLiveAttention({ now: () => time, idleMs: 12000 });
  assert.equal(gate.accept('テレビの会話').action, 'ignore');
  assert.deepEqual(gate.accept('凪！'), { action: 'acknowledge', text: 'ん？' });
  assert.deepEqual(gate.accept('今日は晴れてるね'), { action: 'respond', text: '今日は晴れてるね' });
  time += 12001;
  assert.equal(gate.accept('テレビの会話').action, 'ignore');
  assert.equal(gate.accept('凪の話をしている').action, 'ignore');
  gate.engage();
  assert.equal(gate.accept('おはよう').action, 'respond');
  gate.idle();
  assert.equal(gate.accept('おはよう').action, 'ignore');
});
