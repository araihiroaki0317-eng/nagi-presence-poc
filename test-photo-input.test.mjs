import test from 'node:test';
import assert from 'node:assert/strict';
import { ElevenLabsConversationAdapter, CONVERSATION_PROFILES } from './runtime/conversation-adapter.js';
import { photoDimensions } from './runtime/photo-composer.js';

test('photo dimensions fit portrait and landscape without enlarging small photos', () => {
  assert.deepEqual(photoDimensions(4032, 3024), { width: 1280, height: 960 });
  assert.deepEqual(photoDimensions(3024, 4032), { width: 960, height: 1280 });
  assert.deepEqual(photoDimensions(100, 50), { width: 100, height: 50 });
  assert.throws(() => photoDimensions(0, 20));
});

test('adapter sends photo to Memory once and keeps subsequent text requests text-only', async () => {
  const bodies = [], replies = [];
  const adapter = new ElevenLabsConversationAdapter({ Conversation: { startSession() {} }, agentId: 'mock', memoryConfig: { enabled: true, endpoint: 'https://test', userId: 'hiro', threadId: 'test' }, fetchImpl: async (url, options) => { const body = JSON.parse(options.body); bodies.push(body); return Response.json({ ok: true, response: '模擬応答', ...(body.image ? { image_received: true } : {}) }); } });
  await adapter.start(CONVERSATION_PROFILES.TEXT_SILENT, { onMessage: event => replies.push(event.message) });
  const image = { data_url: 'data:image/png;base64,mock' };
  await adapter.sendText('この写真', { image });
  await adapter.sendText('ありがとう');
  assert.deepEqual(bodies[0].image, image);
  assert.equal(bodies[0].query, 'この写真');
  assert.equal('image' in bodies[1], false);
  assert.equal(replies.length, 2);
  await adapter.end();
});

test('photo cannot silently fall through to an ElevenLabs text-only session', async () => {
  let sent = false;
  const adapter = new ElevenLabsConversationAdapter({ Conversation: { startSession: async () => ({ sendUserMessage() { sent = true; } }) }, agentId: 'mock', memoryConfig: { enabled: false } });
  await adapter.start(CONVERSATION_PROFILES.TEXT_SILENT);
  assert.throws(() => adapter.sendText('写真', { image: { data_url: 'mock' } }), /image_requires_memory_backend/);
  assert.equal(sent, false);
});

test('old backend must acknowledge a photo before any reply is shown or spoken', async () => {
  let shown = false, spoken = false;
  const adapter = new ElevenLabsConversationAdapter({ Conversation: { startSession() {} }, agentId: 'mock', memoryConfig: { enabled: true, endpoint: 'https://test' }, fetchImpl: async () => Response.json({ ok: true, response: '文字だけの応答' }), ttsOutput: { speak() { spoken = true; } } });
  await adapter.start(CONVERSATION_PROFILES.TEXT_AUDIO, { onMessage() { shown = true; } });
  const result = await adapter.sendText('写真', { image: { data_url: 'mock' } });
  assert.equal(result.error, 'image_backend_not_ready');
  assert.equal(shown, false);
  assert.equal(spoken, false);
});
