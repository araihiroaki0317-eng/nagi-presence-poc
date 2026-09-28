import test from 'node:test';
import assert from 'node:assert/strict';
import { CONVERSATION_PROFILES, ElevenLabsConversationAdapter } from '../runtime/conversation-adapter.js';

test('direct voice bypasses ElevenLabs Agent and keeps Memory as response SoT', async () => {
  const calls = [];
  let hooks;
  const Conversation = { async startSession() { calls.push(['unexpected_agent']); } };
  const voiceInput = {
    active: false,
    async start(callbacks) { this.active = true; hooks = callbacks; calls.push(['stt_start']); },
    async stop() { this.active = false; calls.push(['stt_stop']); },
  };
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(['memory', body.query]);
    return { ok: true, async json() { return { response: '凪の返答' }; } };
  };
  const ttsOutput = { async speak(text) { calls.push(['tts', text]); return { ok: true }; } };
  const messages = [];
  const adapter = new ElevenLabsConversationAdapter({ Conversation, agentId: 'agent_test', fetchImpl, ttsOutput, voiceInput, memoryConfig: { enabled: true, endpoint: 'https://memory.test', userId: 'hiro', threadId: 'voice-test' } });
  await adapter.start(CONVERSATION_PROFILES.VOICE, { onMessage: m => messages.push(m) });
  hooks.onPartial?.('こん');
  hooks.onFinal?.('こんにちは');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls.slice(0, 3), [['stt_start'], ['memory', 'こんにちは'], ['tts', '凪の返答']]);
  assert.equal(calls.some(([name]) => name === 'unexpected_agent'), false);
  assert.equal(messages.some(m => m.source === 'ai' && m.message === '凪の返答'), true);
  await adapter.end();
  assert.equal(calls.at(-1)[0], 'stt_stop');
});
