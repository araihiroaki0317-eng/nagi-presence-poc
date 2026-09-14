import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONVERSATION_PROFILES,
  ElevenLabsConversationAdapter,
  memoryConfigFromLocation,
} from '../runtime/conversation-adapter.js';

test('memory backend config accepts explicit Memory endpoint and keeps PoC identity defaults', () => {
  const config = memoryConfigFromLocation('?backend=memory&memoryApi=https%3A%2F%2Fexample.test%2F');
  assert.deepEqual(config, {
    enabled: true,
    endpoint: 'https://example.test',
    userId: 'nagi-poc-test',
    threadId: 'nagi-poc-002',
  });
});

test('M6 text runtime defaults to the live Memory backend without query parameters', () => {
  const config = memoryConfigFromLocation('');
  assert.deepEqual(config, {
    enabled: true,
    endpoint: 'https://nagi-memory-adapter.arai-hiroaki0317.workers.dev',
    userId: 'nagi-poc-test',
    threadId: 'nagi-poc-002',
  });
});

test('ElevenLabs can still be explicitly selected for text fallback', () => {
  const config = memoryConfigFromLocation('?backend=elevenlabs');
  assert.equal(config.enabled, false);
});

test('memory text session does not start ElevenLabs', async () => {
  let elevenStarts = 0;
  const Conversation = {
    async startSession() {
      elevenStarts += 1;
      throw new Error('should_not_start');
    },
  };
  const statuses = [];
  const adapter = new ElevenLabsConversationAdapter({
    Conversation,
    agentId: 'agent_test',
    memoryConfig: {
      enabled: true,
      endpoint: 'https://example.test',
      userId: 'hiro',
      threadId: 'thread-1',
    },
    fetchImpl: async () => new Response(JSON.stringify({ response: '了解' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });

  await adapter.start(CONVERSATION_PROFILES.TEXT_SILENT, {
    onStatusChange(event) { statuses.push(event.status); },
  });
  await Promise.resolve();

  assert.equal(elevenStarts, 0);
  assert.equal(adapter.active, true);
  assert.match(adapter.getId(), /^memory_/);
  assert.ok(statuses.includes('connected'));
});

test('memory text sends /respond request and emits speaking response lifecycle', async () => {
  const requests = [];
  const events = [];
  const Conversation = { async startSession() { throw new Error('should_not_start'); } };
  const adapter = new ElevenLabsConversationAdapter({
    Conversation,
    agentId: 'agent_test',
    memoryConfig: {
      enabled: true,
      endpoint: 'https://memory.example',
      userId: 'hiro-test',
      threadId: 'thread-test',
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ response: '前の話、覚えてるよ。' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  await adapter.start(CONVERSATION_PROFILES.TEXT_SILENT, {
    onModeChange(event) { events.push(['mode', event.mode]); },
    onMessage(event) { events.push(['message', event.source, event.message]); },
  });
  await Promise.resolve();
  events.length = 0;

  await adapter.sendText('前の話を覚えてる？');

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://memory.example/respond');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    query: '前の話を覚えてる？',
    user_id: 'hiro-test',
    thread_id: 'thread-test',
    top_k: 5,
    threshold: 0.1,
  });
  assert.deepEqual(events, [
    ['mode', 'speaking'],
    ['message', 'ai', '前の話、覚えてるよ。'],
    ['mode', 'listening'],
  ]);
});

test('memory backend fails closed when endpoint is not configured', async () => {
  const Conversation = { async startSession() { throw new Error('should_not_start'); } };
  const adapter = new ElevenLabsConversationAdapter({
    Conversation,
    agentId: 'agent_test',
    memoryConfig: { enabled: true, endpoint: '', userId: 'hiro', threadId: 'thread-1' },
    fetchImpl: async () => { throw new Error('should_not_fetch'); },
  });

  await assert.rejects(
    adapter.start(CONVERSATION_PROFILES.TEXT_SILENT),
    /memory_endpoint_required/,
  );
});

test('memory backend request failure is surfaced through callbacks without rejection', async () => {
  const errors = [];
  const modes = [];
  const statuses = [];
  const Conversation = { async startSession() { throw new Error('should_not_start'); } };
  const adapter = new ElevenLabsConversationAdapter({
    Conversation,
    agentId: 'agent_test',
    memoryConfig: {
      enabled: true,
      endpoint: 'https://memory.example',
      userId: 'hiro-test',
      threadId: 'thread-test',
    },
    fetchImpl: async () => new Response(JSON.stringify({ error: 'upstream_failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    }),
  });

  await adapter.start(CONVERSATION_PROFILES.TEXT_SILENT, {
    onError(error) { errors.push(error.message); },
    onModeChange(event) { modes.push(event.mode); },
    onStatusChange(event) { statuses.push(event.status); },
  });
  await Promise.resolve();
  modes.length = 0;
  statuses.length = 0;

  const result = await adapter.sendText('失敗しても落ちない？');

  assert.deepEqual(result, { ok: false, error: 'upstream_failed' });
  assert.deepEqual(errors, ['upstream_failed']);
  assert.deepEqual(modes, ['listening']);
  assert.deepEqual(statuses, ['processing', 'error']);
});