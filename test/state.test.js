import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NagiRuntimeState } from '../runtime/state.js';
import { EventLog } from '../runtime/event-log.js';
import { createCheckpoint, LocalStorageCheckpointStore, contextFromCheckpoint } from '../runtime/checkpoint.js';
import {
  CONVERSATION_PROFILES,
  ElevenLabsConversationAdapter,
  LazyElevenLabsConversationAdapter,
  MockConversationAdapter,
  routeForProfile,
  sessionOptionsFor,
} from '../runtime/conversation-adapter.js';
import { normalizeChannelRoute } from '../runtime/channel-route.js';
import { ConversationCore } from '../runtime/conversation-core.js';
import { MockConversationProvider } from '../providers/mock-provider.js';
import { HttpTextConversationProvider } from '../providers/http-text-provider.js';
import {
  createTextGatewayRequest,
  parseTextGatewayResponse,
  TextGatewayError,
} from '../gateway/text-protocol.js';
import { LocalTranscriptStore, transcriptContext } from '../runtime/transcript.js';
import { budgetNoticeFromError, budgetNoticeFromEvent } from '../runtime/budget-notice.js';
import { RouteAccessController } from '../runtime/route-access.js';
import { selectFallbackRoute } from '../runtime/fallback-router.js';
import {
  GatewaySessionTokenStore,
  MAX_GATEWAY_SESSION_TTL_MS,
} from '../runtime/session-token-store.js';

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

test('input and output channels are independent of provider profiles', () => {
  assert.deepEqual(routeForProfile(CONVERSATION_PROFILES.TEXT_SILENT), {
    inputChannel: 'text', outputChannels: ['text'],
  });
  assert.deepEqual(routeForProfile(CONVERSATION_PROFILES.TEXT_AUDIO), {
    inputChannel: 'text', outputChannels: ['text', 'audio'],
  });
  assert.deepEqual(normalizeChannelRoute({ inputChannel: 'audio', outputChannels: ['text'] }), {
    inputChannel: 'audio', outputChannels: ['text'],
  });
});

test('conversation core preserves one logical conversation across provider reconnects', async () => {
  const events = [];
  let sequence = 0;
  const provider = new MockConversationProvider({ scheduler: callback => callback() });
  const core = new ConversationCore({
    provider,
    eventSink: event => events.push(event),
    idFactory: prefix => `${prefix}_${++sequence}`,
    now: () => '2026-09-04T00:00:00.000Z',
  });

  await core.start({ route: { inputChannel: 'text', outputChannels: ['text'] } });
  const conversationId = core.snapshot().conversation_id;
  await core.submitInput({ content: '続けよう' });
  await core.pause('channel_switch');

  assert.equal(core.snapshot().conversation_status, 'paused');
  assert.equal(core.snapshot().conversation_id, conversationId);

  await core.start({ route: { inputChannel: 'audio', outputChannels: ['text', 'audio'] } });
  assert.equal(core.snapshot().conversation_status, 'active');
  assert.equal(core.snapshot().conversation_id, conversationId);
  assert.equal(core.snapshot().input_channel, 'audio');
  assert.deepEqual(core.snapshot().output_channels, ['text', 'audio']);
  assert.ok(events.some(event => event.type === 'logical_conversation_resumed'));
});

test('conversation core rejects overlapping turns until the active response finishes', async () => {
  let finishResponse;
  const provider = new MockConversationProvider({
    scheduler: callback => { finishResponse = callback; },
  });
  const core = new ConversationCore({ provider });

  await core.start({ route: { inputChannel: 'text', outputChannels: ['text'] } });
  const firstTurn = await core.submitInput({ content: '最初の発話' });
  assert.equal(core.snapshot().active_turn_id, firstTurn);
  assert.equal(core.snapshot().pending_input.content, '最初の発話');
  await assert.rejects(core.submitInput({ content: '重ねて送る' }), /turn_already_active/);

  finishResponse();
  assert.equal(core.snapshot().active_turn_id, null);
  assert.equal(core.snapshot().pending_input, null);
});

test('mock adapter runs through conversation core without an external SDK', async () => {
  const messages = [];
  const modes = [];
  const provider = new MockConversationProvider({ scheduler: callback => callback() });
  const adapter = new MockConversationAdapter({ provider });

  await adapter.start(CONVERSATION_PROFILES.TEXT_SILENT, {
    onMessage: message => messages.push(message),
    onModeChange: event => modes.push(event.mode),
  });
  await adapter.sendText('文字で続ける');

  assert.equal(adapter.core.snapshot().provider_route, 'mock');
  assert.equal(adapter.core.snapshot().input_channel, 'text');
  assert.deepEqual(adapter.core.snapshot().output_channels, ['text']);
  assert.equal(messages.at(-1).message, 'モックで受け取りました。「文字で続ける」');
  assert.ok(modes.includes('speaking'));
  await adapter.end();
  assert.equal(adapter.core.snapshot().conversation_status, 'paused');
});

test('hard-limited voice route falls back to text without losing conversation state', async () => {
  const events = [];
  let sequence = 0;
  const voiceProvider = new MockConversationProvider({ scheduler: callback => callback() });
  voiceProvider.id = 'paid-voice';
  voiceProvider.sendTurn = async () => { throw new Error('budget_hard_limit'); };
  const textProvider = new MockConversationProvider({ scheduler: callback => callback() });
  textProvider.id = 'free-text';
  const access = new RouteAccessController();
  const core = new ConversationCore({
    provider: voiceProvider,
    eventSink: event => events.push(event),
    idFactory: prefix => `${prefix}_${++sequence}`,
    now: () => '2026-09-04T00:00:00.000Z',
  });

  await core.start({ route: { inputChannel: 'audio', outputChannels: ['text', 'audio'] } });
  core.setCheckpoint('checkpoint_before_limit');
  const conversationId = core.snapshot().conversation_id;
  await assert.rejects(core.submitInput({ content: '文字で続きを話す', channel: 'text' }), /budget_hard_limit/);
  assert.equal(core.snapshot().pending_input.content, '文字で続きを話す');

  access.lockRoute({ routeId: 'paid-voice', reason: 'hard_limit', sourceEventId: 'evt_limit' });
  const fallback = selectFallbackRoute({
    fromRouteId: 'paid-voice',
    routes: [{
      route_id: 'free-text', available: true, billing: 'none', priority: 1,
      input_channels: ['text'], output_channels: ['text'],
    }],
    accessController: access,
  });
  assert.equal(fallback.route.route_id, 'free-text');
  assert.equal(fallback.requiresApproval, false);

  await core.switchProvider({
    provider: textProvider,
    route: { inputChannel: 'text', outputChannels: ['text'] },
    context: 'checkpoint_before_limit',
    reason: 'voice_budget_hard_limit',
  });
  await core.retryPendingInput();

  const snapshot = core.snapshot();
  assert.equal(snapshot.conversation_id, conversationId);
  assert.equal(snapshot.latest_checkpoint_id, 'checkpoint_before_limit');
  assert.equal(snapshot.provider_route, 'free-text');
  assert.equal(snapshot.pending_input, null);
  assert.equal(snapshot.fallback_status, 'active');
  assert.ok(events.some(event => event.type === 'logical_conversation_resumed'));
  assert.ok(events.some(event => event.type === 'response.completed'
    && event.payload.text.includes('文字で続きを話す')));
});

test('mock adapter switches to text fallback on the same core and retries pending input', async () => {
  const messages = [];
  const voiceProvider = new MockConversationProvider();
  voiceProvider.id = 'paid-voice';
  voiceProvider.sendTurn = async () => { throw new Error('budget_hard_limit'); };
  const adapter = new MockConversationAdapter({ provider: voiceProvider });
  await adapter.start(CONVERSATION_PROFILES.VOICE, {
    onMessage: message => messages.push(message),
  });
  const conversationId = adapter.getId();
  await assert.rejects(adapter.sendText('入力を失わない'), /budget_hard_limit/);

  const textProvider = new MockConversationProvider({ scheduler: callback => callback() });
  textProvider.id = 'free-text';
  await adapter.switchToTextFallback({ provider: textProvider, context: '直前のチェックポイント' });

  assert.equal(adapter.getId(), conversationId);
  assert.equal(adapter.core.snapshot().provider_route, 'free-text');
  assert.equal(adapter.core.snapshot().pending_input, null);
  assert.equal(messages.at(-1).message, 'モックで受け取りました。「入力を失わない」');
});

test('application startup does not import the ElevenLabs SDK', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import\s+.*@elevenlabs\/client/m);
  assert.doesNotMatch(source, /esm\.sh\/@elevenlabs\/client/);
  assert.match(source, /new LazyElevenLabsConversationAdapter/);
});

test('legacy ElevenLabs adapter loads its SDK only when a session starts', async () => {
  let loads = 0;
  const calls = [];
  const session = {
    sendUserMessage(value) { calls.push(['message', value]); },
    async endSession() { calls.push(['end']); },
  };
  const adapter = new LazyElevenLabsConversationAdapter({
    agentId: 'agent_test',
    sdkLoader: async () => {
      loads += 1;
      return {
        Conversation: {
          async startSession(options) {
            calls.push(['start', options]);
            return session;
          },
        },
      };
    },
  });

  assert.equal(loads, 0);
  await adapter.start(CONVERSATION_PROFILES.TEXT_SILENT);
  assert.equal(loads, 1);
  adapter.sendText('接続後に送信');
  await adapter.end();
  assert.equal(loads, 1);
  assert.deepEqual(calls.map(call => call[0]), ['start', 'message', 'end']);
});

test('failed lazy SDK loading leaves the application adapter inactive', async () => {
  const adapter = new LazyElevenLabsConversationAdapter({
    agentId: 'agent_test',
    sdkLoader: async () => { throw new Error('sdk_unavailable'); },
  });
  await assert.rejects(adapter.start(CONVERSATION_PROFILES.TEXT_SILENT), /sdk_unavailable/);
  assert.equal(adapter.active, false);
});

test('text gateway protocol preserves conversation and turn identity', () => {
  const request = createTextGatewayRequest({
    conversationId: 'conv_1',
    turnId: 'turn_1',
    context: '直前の文脈',
    input: { content: '続きを進めよう', channel: 'text' },
  });
  assert.equal(request.conversation_id, 'conv_1');
  assert.equal(request.turn_id, 'turn_1');
  assert.deepEqual(request.output_channels, ['text']);

  const parsed = parseTextGatewayResponse({
    schema_version: '0.1',
    turn_id: 'turn_1',
    output: { text: '続きから進めよう。' },
    provider: { id: 'test', model: 'test-model' },
  }, 'turn_1');
  assert.equal(parsed.text, '続きから進めよう。');
  assert.throws(() => parseTextGatewayResponse({
    schema_version: '0.1', turn_id: 'wrong', output: { text: '不一致' },
  }, 'turn_1'), /gateway_turn_mismatch/);
});

test('session token store expires credentials and caps lifetime at eight hours', () => {
  let current = Date.parse('2026-09-04T00:00:00.000Z');
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const store = new GatewaySessionTokenStore({ storage, now: () => current });
  const expiresAt = current + MAX_GATEWAY_SESSION_TTL_MS;
  assert.deepEqual(store.save({ token: 'session-device-token', expiresAt }), {
    expires_at: '2026-09-04T08:00:00.000Z',
  });
  assert.equal(store.getToken(), 'session-device-token');
  assert.throws(() => store.save({
    token: 'too-long', expiresAt: current + MAX_GATEWAY_SESSION_TTL_MS + 1,
  }), /device_token_ttl_exceeded/);
  current = expiresAt;
  assert.equal(store.getToken(), null);
  assert.equal(values.size, 0);
});

test('HTTP text provider sends only the gateway device credential', async () => {
  const events = [];
  let captured;
  const provider = new HttpTextConversationProvider({
    gatewayUrl: 'https://gateway.example.test',
    accessTokenProvider: () => 'session-device-token',
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            schema_version: '0.1',
            turn_id: 'turn_7',
            output: { text: '文字経路で返答しました。' },
            provider: { id: 'fake', model: 'fake-text' },
            usage: { status: 'reported', input_units: 10, output_units: 8 },
          };
        },
      };
    },
  });
  await provider.connect({
    conversationId: 'conv_7',
    context: '承認済み文脈',
    route: { inputChannel: 'text', outputChannels: ['text'] },
    emit: event => events.push(event),
  });
  await provider.sendTurn({
    turnId: 'turn_7',
    input: { type: 'text', content: '文字で話す', channel: 'text' },
  });

  assert.equal(captured.url, 'https://gateway.example.test/v1/text/respond');
  assert.equal(captured.body.conversation_id, 'conv_7');
  assert.equal(captured.body.context, '承認済み文脈');
  assert.deepEqual(captured.options.headers, {
    Authorization: 'Bearer session-device-token',
    'Content-Type': 'application/json',
  });
  assert.equal(events.find(event => event.type === 'usage').payload.input_units, 10);
  assert.equal(events.find(event => event.type === 'response.completed').payload.text, '文字経路で返答しました。');
  assert.equal(JSON.stringify(events).includes('session-device-token'), false);
});

test('HTTP text provider normalizes gateway errors and supports interruption', async () => {
  const failedProvider = new HttpTextConversationProvider({
    gatewayUrl: '/gateway',
    accessTokenProvider: () => 'session-device-token',
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      async json() {
        return { error: { code: 'budget_limit', message: 'Budget reached.', retryable: false } };
      },
    }),
  });
  await failedProvider.connect({
    conversationId: 'conv_8',
    route: { inputChannel: 'text', outputChannels: ['text'] },
    emit: () => {},
  });
  await assert.rejects(
    failedProvider.sendTurn({ turnId: 'turn_8', input: { content: '送信' } }),
    error => error instanceof TextGatewayError && error.code === 'budget_limit' && error.retryable === false,
  );

  let signal;
  const interruptedEvents = [];
  const interruptedProvider = new HttpTextConversationProvider({
    gatewayUrl: 'http://localhost:8787',
    accessTokenProvider: () => 'session-device-token',
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  await interruptedProvider.connect({
    conversationId: 'conv_9',
    route: { inputChannel: 'text', outputChannels: ['text'] },
    emit: event => interruptedEvents.push(event),
  });
  const pending = interruptedProvider.sendTurn({ turnId: 'turn_9', input: { content: '止める' } });
  await Promise.resolve();
  assert.equal(interruptedProvider.interrupt({ turnId: 'turn_9' }), true);
  await assert.rejects(pending, error => error.code === 'turn_interrupted');
  assert.equal(signal.aborted, true);
  assert.equal(interruptedEvents.at(-1).payload.code, 'turn_interrupted');
});

test('HTTP text provider rejects insecure remote gateway URLs', () => {
  assert.throws(() => new HttpTextConversationProvider({
    gatewayUrl: 'http://public.example.test', fetchImpl: async () => {},
  }), /gateway_url_must_be_https_or_local/);
});

test('HTTP text provider fails before network use when the device token is absent', async () => {
  let fetchCalled = false;
  const provider = new HttpTextConversationProvider({
    gatewayUrl: 'https://gateway.example.test',
    accessTokenProvider: () => null,
    fetchImpl: async () => { fetchCalled = true; },
  });
  await provider.connect({
    conversationId: 'conv_auth',
    route: { inputChannel: 'text', outputChannels: ['text'] },
    emit: () => {},
  });
  await assert.rejects(
    provider.sendTurn({ turnId: 'turn_auth', input: { content: '送信しない' } }),
    error => error.code === 'device_token_required' && error.retryable === false,
  );
  assert.equal(fetchCalled, false);
});

test('budget notices distinguish warning from a stopped paid route', () => {
  const soft = budgetNoticeFromEvent({
    type: 'budget.soft_limit',
    payload: { reasons: ['monthly_cost_soft_limit'] },
  });
  assert.equal(soft.severity, 'soft');
  assert.equal(soft.paidRouteAllowed, true);
  assert.equal(soft.requiresDecision, true);

  const hard = budgetNoticeFromError({
    code: 'budget_limit',
    limitReason: 'monthly_cost_hard_limit',
    message: 'Request denied',
  });
  assert.equal(hard.severity, 'hard');
  assert.equal(hard.paidRouteAllowed, false);
  assert.deepEqual(hard.reasons, ['monthly_cost_hard_limit']);
  assert.equal(budgetNoticeFromError(new Error('ordinary network error')), null);
});

test('HTTP text provider emits a soft budget signal from a gateway response', async () => {
  const events = [];
  const provider = new HttpTextConversationProvider({
    gatewayUrl: 'https://gateway.example.test',
    accessTokenProvider: () => 'session-device-token',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            schema_version: '0.1',
            turn_id: body.turn_id,
            output: { text: 'まだ続けられます。' },
            provider: { id: 'fake', model: 'fake-text' },
            gateway_budget: {
              status: 'committed',
              warning: { level: 'soft_limit', reasons: ['monthly_cost_soft_limit'] },
            },
          };
        },
      };
    },
  });
  await provider.connect({
    conversationId: 'conv_budget',
    route: { inputChannel: 'text', outputChannels: ['text'] },
    emit: event => events.push(event),
  });
  await provider.sendTurn({ turnId: 'turn_budget', input: { content: '続けよう' } });
  const budgetEvent = events.find(event => event.type === 'budget.soft_limit');
  assert.deepEqual(budgetEvent.payload.reasons, ['monthly_cost_soft_limit']);
});

test('Presence UI exposes text fallback only when an available route is registered', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="budgetNotice"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="budgetMessage"/);
  assert.doesNotMatch(html, /id="budgetContinueText"/);
  assert.match(app, /routeAccess\.lockRoute/);
  assert.match(app, /const routeRegistry = MOCK_MODE \?/);
  assert.match(app, /const textFallbackAvailable = Boolean\(textFallbackSelection\(\)\.route\)/);
  assert.match(app, /sendTextBtn\.disabled = connecting \|\| \(paidRouteBlocked && !textFallbackAvailable\)/);
  assert.match(app, /conversation: continued in text/);
});

function approvedEnvelope(overrides = {}) {
  return {
    envelope_id: 'env_new',
    route_id: 'gateway-text',
    provider_id: 'provider-a',
    model_id: 'model-a',
    currency: 'JPY',
    hard_limit_micros: 1000000,
    status: 'approved',
    approval_source: 'explicit_user',
    source_event_id: 'evt_approval',
    approved_at: '2026-09-04T00:00:00.000Z',
    allow_automatic_fallback: false,
    ...overrides,
  };
}

test('a hard-locked route requires a new explicitly approved envelope', () => {
  const access = new RouteAccessController();
  access.applyApprovedEnvelope(approvedEnvelope({ envelope_id: 'env_old' }));
  access.lockRoute({ routeId: 'gateway-text', envelopeId: 'env_old', reason: 'hard_limit' });
  assert.equal(access.canUse('gateway-text'), false);

  const replayed = access.applyApprovedEnvelope(approvedEnvelope({ envelope_id: 'env_old' }));
  assert.equal(replayed.unlocked, false);
  assert.equal(access.canUse('gateway-text'), false);

  const renewed = access.applyApprovedEnvelope(approvedEnvelope({ envelope_id: 'env_new' }));
  assert.equal(renewed.unlocked, true);
  assert.equal(access.canUse('gateway-text'), true);
  assert.throws(() => access.applyApprovedEnvelope(approvedEnvelope({
    envelope_id: 'env_bad', status: 'draft',
  })), /envelope_not_approved/);
});

test('fallback router automatically selects an available no-billing text route', () => {
  const access = new RouteAccessController();
  const result = selectFallbackRoute({
    fromRouteId: 'voice-paid',
    accessController: access,
    routes: [
      {
        route_id: 'text-free', billing: 'none', available: true,
        input_channels: ['text'], output_channels: ['text'], priority: 1,
      },
    ],
  });
  assert.equal(result.route.route_id, 'text-free');
  assert.equal(result.requiresApproval, false);
});

test('metered fallback requires an approved envelope and explicit automatic permission', () => {
  const access = new RouteAccessController();
  const routes = [{
    route_id: 'gateway-text', billing: 'metered', available: true,
    input_channels: ['text'], output_channels: ['text'], priority: 1,
  }];

  const unavailable = selectFallbackRoute({
    fromRouteId: 'voice-paid', routes, accessController: access,
  });
  assert.equal(unavailable.route, null);
  assert.equal(unavailable.requiresApproval, false);

  access.applyApprovedEnvelope(approvedEnvelope());
  const confirmationRequired = selectFallbackRoute({
    fromRouteId: 'voice-paid', routes, accessController: access,
  });
  assert.equal(confirmationRequired.route, null);
  assert.equal(confirmationRequired.requiresApproval, true);

  access.applyApprovedEnvelope(approvedEnvelope({
    envelope_id: 'env_auto', allow_automatic_fallback: true,
  }));
  const automatic = selectFallbackRoute({
    fromRouteId: 'voice-paid', routes, accessController: access,
  });
  assert.equal(automatic.route.route_id, 'gateway-text');
  assert.equal(automatic.requiresApproval, false);
});
