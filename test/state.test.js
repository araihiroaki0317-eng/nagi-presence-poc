import test from 'node:test';
import assert from 'node:assert/strict';
import { NagiRuntimeState } from '../runtime/state.js';
import { EventLog } from '../runtime/event-log.js';
import { createCheckpoint, LocalStorageCheckpointStore, contextFromCheckpoint } from '../runtime/checkpoint.js';
import {
  CONVERSATION_PROFILES,
  ElevenLabsConversationAdapter,
  sessionOptionsFor,
} from '../runtime/conversation-adapter.js';
import { LocalTranscriptStore, transcriptContext } from '../runtime/transcript.js';

test('current turn override expires deterministically', () => {
  const state = new NagiRuntimeState();
  state.setOverride({
    type: 'mode', value: 'critical', scope: 'current_turn', source_event_id: 'evt_1',
  });
  assert.equal(state.snapshot().mode_override.value, 'critical');
  const expired = state.expireScope('current_turn');
  assert.equal(expired[0].status, 'expired');
  assert.equal(state.snapshot().mode_override, null);
});

test('project state requires provenance', () => {
  const state = new NagiRuntimeState();
  assert.throws(() => state.setActiveProject({ project_id: 'nagi', status: 'foreground' }),
    /source_event_id_required/);
});

test('undefined modes cannot be injected as overrides', () => {
  const state = new NagiRuntimeState();
  assert.throws(() => state.setOverride({
    type: 'mode', value: 'angry', scope: 'current_session', source_event_id: 'evt_2',
  }), /invalid_mode_override_value/);
  assert.equal(state.snapshot().mode_override, null);
});

test('event log assigns order and suppresses duplicate idempotency keys', async () => {
  const rows = [];
  const store = {
    async read() { return rows; },
    async append(event) {
      if (event.idempotency_key && rows.some(row => row.idempotency_key === event.idempotency_key)) {
        return { event, duplicate: true };
      }
      rows.push(event);
      return { event, duplicate: false };
    },
  };
  const log = new EventLog(store);
  await log.append({ event_type: 'session_started', idempotency_key: 'start-1' });
  const duplicate = await log.append({ event_type: 'session_started', idempotency_key: 'start-1' });
  await log.append({ event_type: 'session_ended' });
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(rows.map(row => row.sequence_number), [1, 2]);
});

test('checkpoint preserves facts without inventing analysis', () => {
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, value); },
  };
  const store = new LocalStorageCheckpointStore('checkpoint', storage);
  const checkpoint = createCheckpoint({
    source_event_id: 'evt_10',
    active_project: { project_id: 'nagi', phase: '2d', current_topic: 'checkpoint' },
    recent_turns: [{ role: 'user', text: '続きをやろう' }],
    reason: 'completed_turn',
  });
  store.save(checkpoint);
  const restored = store.readLatest();
  assert.deepEqual(restored.confirmed_decisions, []);
  assert.match(contextFromCheckpoint(restored), /Active project: nagi/);
  assert.match(contextFromCheckpoint(restored), /ヒロ: 続きをやろう/);
});

test('text-only profile uses websocket without microphone audio', () => {
  const options = sessionOptionsFor(CONVERSATION_PROFILES.TEXT_SILENT);
  assert.equal(options.connectionType, 'websocket');
  assert.equal(options.textOnly, true);
  assert.equal(options.overrides.conversation.textOnly, true);
});

test('typed message can use a voice reply while microphone stays muted', async () => {
  const calls = [];
  const session = {
    setMicMuted(value) { calls.push(['mute', value]); },
    sendUserMessage(value) { calls.push(['message', value]); },
    async endSession() { calls.push(['end']); },
  };
  const Conversation = {
    async startSession(options) {
      calls.push(['start', options]);
      return session;
    },
  };
  const adapter = new ElevenLabsConversationAdapter({ Conversation, agentId: 'agent_test' });
  await adapter.start(CONVERSATION_PROFILES.TEXT_AUDIO);
  adapter.sendText('文字で送る');
  await adapter.end();
  assert.equal(calls[0][1].connectionType, 'webrtc');
  assert.equal(calls[0][1].micMuted, true);
  assert.deepEqual(calls.slice(1), [['mute', true], ['message', '文字で送る'], ['end']]);
});

test('transcript merges growing sdk text and keeps typed turns distinct', () => {
  const storage = new Map();
  const memory = {
    getItem(key) { return storage.get(key) || null; },
    setItem(key, value) { storage.set(key, value); },
  };
  const store = new LocalTranscriptStore('transcript', memory);
  store.append({ role: 'agent', text: '少し', source: 'sdk', ts: 1000 });
  const grown = store.append({ role: 'agent', text: '少し考えます。', source: 'sdk', ts: 1100 });
  store.append({ role: 'user', text: 'お願いします', source: 'typed', input_channel: 'text', ts: 1200 });
  assert.equal(grown.replaced, true);
  assert.equal(store.read().length, 2);
  assert.equal(store.read()[0].text, '少し考えます。');
  assert.match(transcriptContext(store.read()), /ヒロ: お願いします/);
});
