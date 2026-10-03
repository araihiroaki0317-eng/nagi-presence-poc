import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioStatsSnapshot, audioStatsDelta, monitorAvatarAudio } from '../runtime/avatar-audio-stats.js';

test('only audio counters and codec metadata are retained, no candidate addresses', () => {
  const snapshot = audioStatsSnapshot(new Map([
    ['v', { type: 'inbound-rtp', kind: 'video', packetsReceived: 900 }],
    ['a', { id: 'a', type: 'inbound-rtp', kind: 'audio', timestamp: 1000, codecId: 'c', packetsReceived: 50, address: 'private' }],
    ['c', { mimeType: 'audio/opus', clockRate: 48000, channels: 2 }],
    ['ip', { type: 'local-candidate', address: 'private' }],
  ]));
  assert.equal(snapshot.packetsReceived, 50);
  assert.equal(snapshot.clockRate, 48000);
  assert.equal(snapshot.concealedSamples, undefined); // Unsupported is not zero.
  assert.ok(!JSON.stringify(snapshot).includes('private'));
});

test('interval deltas distinguish loss, concealment, and slowing; resets are excluded', () => {
  const before = { id: 'a', timestamp: 1000, packetsLost: 4, concealedSamples: 20,
    insertedSamplesForDeceleration: 0, jitterBufferDelay: 2, jitterBufferEmittedCount: 100 };
  const after = { id: 'a', timestamp: 2000, packetsLost: 3, concealedSamples: 30,
    insertedSamplesForDeceleration: 480, jitterBufferDelay: 4, jitterBufferEmittedCount: 200, jitter: .012 };
  const delta = audioStatsDelta(before, after);
  assert.equal(delta.packetsLost, -1);
  assert.equal(delta.concealedSamples, 10);
  assert.equal(delta.insertedSamplesForDeceleration, 480);
  assert.equal(delta.mean_buffer_ms, 20);
  assert.equal(delta.jitter_ms, 12);
  assert.equal(audioStatsDelta(before, { ...after, id: 'new' }), null);
  assert.equal(audioStatsDelta(before, { ...after, concealedSamples: 0 }), null);
});

test('stopping during an asynchronous read suppresses late results', async () => {
  let resolve;
  const samples = [];
  const monitor = monitorAvatarAudio({ getRTCStatsReport: () => new Promise(r => { resolve = r; }) }, s => samples.push(s));
  monitor.stop();
  resolve(new Map());
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(samples, []);
});

test('missing stats is nonfatal and explicitly unavailable', async () => {
  const samples = [];
  const monitor = monitorAvatarAudio({}, s => samples.push(s));
  await new Promise(r => setTimeout(r, 5));
  monitor.stop();
  assert.deepEqual(samples, [{ state: 'unavailable' }]);
});
