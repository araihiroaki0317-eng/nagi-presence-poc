import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechEngineTransport, latestUserTranscript } from '../runtime/speech-engine-transport.js';

test('extracts latest direct transcript', () => {
  assert.equal(latestUserTranscript({ type: 'user_transcript', user_transcript: 'こんにちは' }), 'こんにちは');
});

test('forwards the exact CreO response as agent_response', async () => {
  let requestBody;
  let outgoing;
  const handle = createSpeechEngineTransport({
    respondEndpoint: 'https://memory.example',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ response: '凪の確定回答' }) };
    },
  });

  const result = await handle(
    { type: 'user_transcript', event_id: 42, user_transcript: 'テスト' },
    { send: async message => { outgoing = message; }, userId: 'hiro', threadId: 'nagi-poc-002' },
  );

  assert.equal(requestBody.query, 'テスト');
  assert.equal(requestBody.user_id, 'hiro');
  assert.equal(requestBody.thread_id, 'nagi-poc-002');
  assert.deepEqual(outgoing, {
    type: 'agent_response',
    event_id: 42,
    agent_response: '凪の確定回答',
  });
  assert.deepEqual(result, { ok: true, event_id: 42, text: '凪の確定回答' });
});

test('does not call /respond for unrelated events', async () => {
  let called = false;
  const handle = createSpeechEngineTransport({
    respondEndpoint: 'https://memory.example',
    fetchImpl: async () => { called = true; },
  });
  const result = await handle({ type: 'ping' }, { send: async () => {} });
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
    { type: 'user_transcript', event_id: 1, user_transcript: '古い入力' },
    { signal: controller.signal, send: async () => { sent = true; }, userId: 'hiro', threadId: 'nagi-poc-002' },
  );
  assert.deepEqual(result, { ok: false, reason: 'aborted' });
  assert.equal(sent, false);
});


test('requires caller-owned session identity', async () => {
  const handle = createSpeechEngineTransport({
    respondEndpoint: 'https://memory.example',
    fetchImpl: async () => { throw new Error('must_not_call'); },
  });
  await assert.rejects(
    () => handle(
      { type: 'user_transcript', event_id: 7, user_transcript: 'test' },
      { send: async () => {} },
    ),
    /user_id_required/,
  );
});
