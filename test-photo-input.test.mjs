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

test('photo conversation keeps image across typed and voice turns and resumes paused mic', async () => {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('./bithuman-photo-preview.js', import.meta.url), 'utf8');
  const send = source.slice(source.indexOf('async function sendText('), source.indexOf("$('start').onclick"));
  const image = { data_url: 'data:image/jpeg;base64,mock' };
  const calls = [], elements = { text: { value: '写真について' } };
  const context = { photos: { image, preparing: false, clear() { throw new Error('Photo must remain attached'); } }, connected: true, busy: false, muted: true, resumeAfterPhoto: true, micTimer: null, sessionLimit: { finishTurn() {} }, voiceInput: { async stop() {} }, adapter: { async sendText(query, options) { calls.push({ query, ...options }); return { ok: true }; } }, $: id => elements[id], controls() {}, clearTimeout() {}, appendTranscript() {}, prefetchScribeToken() {}, status() {}, log() {}, performance, attention: { engage() {} }, async listenAutomatically() { context.listens++; }, listens: 0 };
  runInNewContext(send + ';this.sendText=sendText;', context);
  await context.sendText('この写真どう？', image);
  await context.sendText('右側はどう思う？'); // voice transcript uses the default attachment
  await context.sendText('もう少し説明して', context.photos.image); // typed form
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.image === image));
  assert.equal(context.muted, false);
  assert.equal(context.listens, 3);
  context.photos.image = null;
  await context.sendText('別の話をしよう');
  assert.equal(calls[3].image, null);
});
