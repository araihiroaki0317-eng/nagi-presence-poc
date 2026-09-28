import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechEngineTransport, latestUserTranscript } from '../runtime/speech-engine-transport.js';

test('extracts latest user message from Speech Engine transcript history', () => {
  assert.equal(latestUserTranscript({
    type: 'user_transcript',
    user_transcript: [
      { role: 'user', content: '前の質問' },
      { role: 'agent', content: '前の回答' },
      { role: 'user', content: 'こんにちは' },
    ],
  }), 'こんにちは');
});

test('forwards exact CreO response using current Speech Engine wire format', async () => {
  let requestBody;
  const outgoing = [];
  const handle = createSpeechEngineTransport({
    respondEndpoint: 'https://memory.example',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ response: '凪の確定回答' }) };
    },
  });

  const result = await handle(
    { type: 'user_transcript', event_id: 42, user_transcript: [{ role: 'user', content: 'テスト' }] },
    { send: async message => outgoing.push(message) },
  );

  assert.equal(requestBody.query, 'テスト');
  assert.equal(requestBody.user_id, 'hiro');
  assert.equal(requestBody.thread_id, 'nagi-poc-002');
  assert.deepEqual(outgoing, [
    { type: 'agent_response', event_id: 42, content: '凪の確定回答', is_final: false },
    { type: 'agent_response', event_id: 42, content: '', is_final: true },
  ]);
  assert.deepEqual(result, { ok: true, event_id: 42, text: '凪の確定回答' });
});

test('responds to Speech Engine keepalive ping', async () => {
  const outgoing = [];
  const handle = createSpeechEngineTransport({
    respondEndpoint: 'https://memory.example',
    fetchImpl: async () => { throw new Error('must_not_call'); },
  });
  const result = await handle({ type: 'ping' }, { send: async message => outgoing.push(message) });
  assert.deepEqual(outgoing, [{ type: 'pong' }]);
  assert.deepEqual(result, { ok: true, pong: true });
});

test('does not call /respond for unrelated events', async () => {
  let called = false;
  const handle = createSpeechEngineTransport({
    respondEndpoint: 'https://memory.example',
    fetchImpl: async () => { called = true; },
  });
  const result = await handle({ type: 'init', conversation_id: 'conv_1' }, { send: async () => {} });
  assert.deepEqual(result, { ok: false, ignored: true });
  assert.equal(called, false);
});

test('does not send a response after cancellation', async () => {
  const controller = new AbortController();
  let sent = false;
  const handle = createSpeechEngineTransport({
    respondEndpoint: 'https://memory.example',
    fetchImpl: async () => {
      controller.abort();
      return { ok: true, json: async () => ({ response: '古い回答' }) };
    },
  });
  const result = await handle(
    { type: 'user_transcript', event_id: 1, user_transcript: [{ role: 'user', content: '古い入力' }] },
    { signal: controller.signal, send: async () => { sent = true; } },
  );
  assert.deepEqual(result, { ok: false, reason: 'aborted' });
  assert.equal(sent, false);
});


test('uses the approved PoC Memory identity by default', async () => {
  let requestBody;
  const handle = createSpeechEngineTransport({
    respondEndpoint: 'https://memory.example',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ response: 'ok' }) };
    },
  });
  await handle(
    { type: 'user_transcript', event_id: 8, user_transcript: [{ role: 'user', content: 'test' }] },
    { send: async () => {} },
  );
  assert.equal(requestBody.user_id, 'hiro');
  assert.equal(requestBody.thread_id, 'nagi-poc-002');
});
