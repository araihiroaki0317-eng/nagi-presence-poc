import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '../conversation-gateway/auth.js';
import { InMemoryBudgetGuard } from '../conversation-gateway/budget-guard.js';
import { InMemoryBudgetStore } from '../conversation-gateway/budget-store.js';
import { handleRequest } from '../conversation-gateway/worker.js';
import { handleWorkersAIProvider } from '../conversation-gateway/workers-ai-provider.js';

const ORIGIN = 'https://araihiroaki0317-eng.github.io';
const DEVICE_TOKEN = 'local-test-device-token';

async function environment(overrides = {}) {
  return {
    ALLOWED_ORIGIN: ORIGIN,
    DEVICE_TOKEN_SHA256: await sha256Hex(DEVICE_TOKEN),
    COST_ESTIMATOR: {
      async fetch() {
        return Response.json({
          estimate_id: 'estimate_test',
          provider_id: 'fake',
          model_id: 'fake-text',
          max_output_units: 100,
          estimated_cost_micros: 100,
          currency: 'TEST',
        });
      },
    },
    ...overrides,
  };
}

function request(path, { method = 'POST', token = DEVICE_TOKEN, origin = ORIGIN, body } = {}) {
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(`https://gateway.example.test${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function validBody() {
  return {
    schema_version: '0.1',
    conversation_id: 'conv_1',
    turn_id: 'turn_1',
    context: '直前の文脈',
    input: { type: 'text', content: '続きを進めよう', channel: 'text' },
    output_channels: ['text'],
  };
}

test('gateway health reports configuration without exposing values', async () => {
  const response = await handleRequest(request('/health', { method: 'GET', token: null }), await environment());
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.device_auth_configured, true);
  assert.equal(payload.provider_configured, false);
  assert.equal(JSON.stringify(payload).includes(DEVICE_TOKEN), false);
});

test('gateway rejects an unapproved origin and missing device token', async () => {
  const env = await environment();
  const wrongOrigin = await handleRequest(request('/v1/text/respond', {
    origin: 'https://attacker.example', body: validBody(),
  }), env);
  assert.equal(wrongOrigin.status, 403);

  const missingToken = await handleRequest(request('/v1/text/respond', {
    token: null, body: validBody(),
  }), env);
  assert.equal(missingToken.status, 401);
  assert.equal((await missingToken.json()).error.code, 'device_token_required');
});

test('gateway fails closed when the budget guard is absent', async () => {
  const response = await handleRequest(
    request('/v1/text/respond', { body: validBody() }),
    await environment(),
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'budget_guard_not_configured');
});

test('gateway calls the provider only after local budget authorization', async () => {
  const calls = [];
  const env = await environment({
    BUDGET_GUARD: {
      async fetch(url, options) {
        const operation = new URL(url).pathname.slice(1);
        calls.push([`budget_${operation}`, JSON.parse(options.body)]);
        if (operation === 'authorize') return Response.json({ allowed: true, reservation_id: 'reservation_1' });
        if (operation === 'commit') return Response.json({ ok: true });
        return Response.json({ ok: true });
      },
    },
    TEXT_PROVIDER: {
      async fetch(_url, options) {
        const body = JSON.parse(options.body);
        calls.push(['provider', body]);
        assert.equal(body.execution.provider_id, 'fake');
        assert.equal(body.execution.model_id, 'fake-text');
        assert.equal(body.execution.max_output_units, 100);
        return Response.json({
          schema_version: '0.1',
          turn_id: body.turn_id,
          output: { text: '疑似Providerの返答です。' },
          provider: { id: 'fake', model: 'fake-text' },
          usage: { status: 'reported', input_units: 12, output_units: 9 },
        });
      },
    },
  });

  const response = await handleRequest(request('/v1/text/respond', { body: validBody() }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map(call => call[0]), ['budget_authorize', 'provider', 'budget_commit']);
  const payload = await response.json();
  assert.equal(payload.output.text, '疑似Providerの返答です。');
  assert.equal(payload.gateway_budget.status, 'committed');
});

test('gateway never calls the provider twice for the same turn identity', async () => {
  let providerCalls = 0;
  const guard = new InMemoryBudgetGuard({
    limits: {
      monthlyTurnLimit: 10,
      conversationTurnLimit: 10,
      monthlyCharacterLimit: 10000,
      conversationCharacterLimit: 10000,
      monthlyCostHardLimitMicros: 10000,
      conversationCostHardLimitMicros: 10000,
    },
  });
  const env = await environment({
    BUDGET_GUARD: guard,
    TEXT_PROVIDER: {
      async fetch(_url, options) {
        providerCalls += 1;
        const body = JSON.parse(options.body);
        return Response.json({
          schema_version: '0.1',
          turn_id: body.turn_id,
          output: { text: '一度だけ返します。' },
          provider: { id: 'fake', model: 'fake-text' },
          usage: { output_units: 5, cost_micros: 100 },
        });
      },
    },
  });

  const first = await handleRequest(request('/v1/text/respond', { body: validBody() }), env);
  const duplicate = await handleRequest(request('/v1/text/respond', { body: validBody() }), env);

  assert.equal(first.status, 200);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'duplicate_turn');
  assert.equal(providerCalls, 1);
  assert.equal(guard.snapshot().totals.committedTurns, 1);
});

test('gateway does not call a provider after budget denial', async () => {
  let providerCalled = false;
  const env = await environment({
    BUDGET_GUARD: { async fetch() { return Response.json({ allowed: false }); } },
    TEXT_PROVIDER: {
      async fetch() {
        providerCalled = true;
        return Response.json({});
      },
    },
  });
  const response = await handleRequest(request('/v1/text/respond', { body: validBody() }), env);
  assert.equal(response.status, 429);
  assert.equal(providerCalled, false);
});

test('gateway rejects oversized messages before budget or provider calls', async () => {
  let bindingCalled = false;
  const binding = { async fetch() { bindingCalled = true; return Response.json({ allowed: true }); } };
  const env = await environment({ BUDGET_GUARD: binding, TEXT_PROVIDER: binding });
  const body = validBody();
  body.input.content = 'x'.repeat(2001);
  const response = await handleRequest(request('/v1/text/respond', { body }), env);
  assert.equal(response.status, 413);
  assert.equal(bindingCalled, false);
});

test('budget guard reserves before use and commits idempotently', async () => {
  let sequence = 0;
  const guard = new InMemoryBudgetGuard({
    limits: {
      monthlyTurnLimit: 10,
      conversationTurnLimit: 5,
      monthlyCharacterLimit: 1000,
      conversationCharacterLimit: 500,
      monthlyCostHardLimitMicros: 1000,
      conversationCostHardLimitMicros: 500,
    },
    now: () => new Date('2026-09-04T00:00:00.000Z'),
    idFactory: () => `reservation_${++sequence}`,
  });
  const first = await guard.authorize({
    conversation_id: 'conv_1', turn_id: 'turn_1', input_characters: 20, context_characters: 30,
    estimated_cost_micros: 100, currency: 'TEST',
  });
  const duplicate = await guard.authorize({
    conversation_id: 'conv_1', turn_id: 'turn_1', input_characters: 20, context_characters: 30,
    estimated_cost_micros: 100, currency: 'TEST',
  });
  assert.equal(first.allowed, true);
  assert.equal(duplicate.reservation_id, first.reservation_id);
  assert.equal(guard.snapshot().totals.reservedTurns, 1);

  const committed = await guard.commit({ reservation_id: first.reservation_id, usage: { output_units: 7 } });
  const committedAgain = await guard.commit({ reservation_id: first.reservation_id });
  assert.equal(committed.ok, true);
  assert.equal(committedAgain.duplicate, true);
  assert.equal(guard.snapshot().totals.reservedTurns, 0);
  assert.equal(guard.snapshot().totals.committedTurns, 1);
  assert.equal(guard.snapshot().totals.committedCharacters, 50);
  assert.equal(guard.snapshot().totals.committedCostMicros, 100);
});

test('budget guard counts concurrent reservations and release restores capacity', async () => {
  let sequence = 0;
  const guard = new InMemoryBudgetGuard({
    limits: {
      monthlyTurnLimit: 2,
      conversationTurnLimit: 2,
      monthlyCharacterLimit: 100,
      conversationCharacterLimit: 100,
      monthlyCostHardLimitMicros: 250,
      conversationCostHardLimitMicros: 250,
    },
    now: () => new Date('2026-09-04T00:00:00.000Z'),
    idFactory: () => `reservation_${++sequence}`,
  });
  const one = await guard.authorize({
    conversation_id: 'conv_1', turn_id: 'turn_1', input_characters: 40, estimated_cost_micros: 100,
  });
  const two = await guard.authorize({
    conversation_id: 'conv_1', turn_id: 'turn_2', input_characters: 40, estimated_cost_micros: 100,
  });
  const denied = await guard.authorize({
    conversation_id: 'conv_1', turn_id: 'turn_3', input_characters: 1, estimated_cost_micros: 10,
  });
  assert.equal(one.allowed, true);
  assert.equal(two.allowed, true);
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'monthly_turn_limit');

  await guard.release({ reservation_id: two.reservation_id });
  const replacement = await guard.authorize({
    conversation_id: 'conv_1', turn_id: 'turn_3', input_characters: 10, estimated_cost_micros: 10,
  });
  assert.equal(replacement.allowed, true);
  assert.equal(guard.snapshot().totals.reservedTurns, 2);
});

test('gateway releases a reservation when the provider is unavailable', async () => {
  const guard = new InMemoryBudgetGuard({
    limits: {
      monthlyTurnLimit: 2,
      conversationTurnLimit: 2,
      monthlyCharacterLimit: 1000,
      conversationCharacterLimit: 1000,
      monthlyCostHardLimitMicros: 1000,
      conversationCostHardLimitMicros: 1000,
    },
  });
  const env = await environment({ BUDGET_GUARD: guard });
  const response = await handleRequest(request('/v1/text/respond', { body: validBody() }), env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'provider_not_configured');
  assert.equal(guard.snapshot().totals.reservedTurns, 0);
  assert.equal(guard.snapshot().reservations[0].status, 'released');
});

test('budget guard refuses to initialize without explicit positive limits', () => {
  assert.throws(() => new InMemoryBudgetGuard({ limits: {} }), /required/);
});

test('budget guard warns at a soft cost limit and blocks before the hard limit is exceeded', async () => {
  let sequence = 0;
  const guard = new InMemoryBudgetGuard({
    limits: {
      monthlyTurnLimit: 10,
      conversationTurnLimit: 10,
      monthlyCharacterLimit: 1000,
      conversationCharacterLimit: 1000,
      monthlyCostSoftLimitMicros: 150,
      monthlyCostHardLimitMicros: 250,
      conversationCostSoftLimitMicros: 150,
      conversationCostHardLimitMicros: 250,
    },
    idFactory: () => `reservation_${++sequence}`,
  });
  const first = await guard.authorize({
    conversation_id: 'conv_soft', turn_id: 'turn_1', input_characters: 10, estimated_cost_micros: 100,
  });
  const second = await guard.authorize({
    conversation_id: 'conv_soft', turn_id: 'turn_2', input_characters: 10, estimated_cost_micros: 100,
  });
  const blocked = await guard.authorize({
    conversation_id: 'conv_soft', turn_id: 'turn_3', input_characters: 10, estimated_cost_micros: 100,
  });
  assert.equal(first.warning, null);
  assert.equal(second.warning.level, 'soft_limit');
  assert.deepEqual(second.warning.reasons, ['monthly_cost_soft_limit', 'conversation_cost_soft_limit']);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'monthly_cost_hard_limit');
});

test('gateway blocks before budget and provider calls when cost estimation is absent', async () => {
  let downstreamCalled = false;
  const binding = { async fetch() { downstreamCalled = true; return Response.json({}); } };
  const env = await environment({ COST_ESTIMATOR: null, BUDGET_GUARD: binding, TEXT_PROVIDER: binding });
  const response = await handleRequest(request('/v1/text/respond', { body: validBody() }), env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'cost_estimator_not_configured');
  assert.equal(downstreamCalled, false);
});

test('gateway rejects a silent provider or model substitution and still commits the reservation', async () => {
  const guard = new InMemoryBudgetGuard({
    limits: {
      monthlyTurnLimit: 10,
      conversationTurnLimit: 10,
      monthlyCharacterLimit: 1000,
      conversationCharacterLimit: 1000,
      monthlyCostHardLimitMicros: 1000,
      conversationCostHardLimitMicros: 1000,
    },
  });
  const env = await environment({
    BUDGET_GUARD: guard,
    TEXT_PROVIDER: {
      async fetch(_url, options) {
        const body = JSON.parse(options.body);
        return Response.json({
          schema_version: '0.1',
          turn_id: body.turn_id,
          output: { text: '別モデルの返答' },
          provider: { id: 'fake', model: 'unexpected-expensive-model' },
          usage: { output_units: 10, cost_micros: 90 },
        });
      },
    },
  });
  const response = await handleRequest(request('/v1/text/respond', { body: validBody() }), env);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'provider_response_invalid');
  assert.equal(guard.snapshot().totals.committedTurns, 1);
  assert.equal(guard.snapshot().totals.committedCostMicros, 90);
});

test('gateway holds a reservation when the provider outcome is unknown', async () => {
  const guard = new InMemoryBudgetGuard({
    limits: {
      monthlyTurnLimit: 10,
      conversationTurnLimit: 10,
      monthlyCharacterLimit: 1000,
      conversationCharacterLimit: 1000,
      monthlyCostHardLimitMicros: 1000,
      conversationCostHardLimitMicros: 1000,
    },
  });
  const env = await environment({
    BUDGET_GUARD: guard,
    TEXT_PROVIDER: { async fetch() { throw new Error('connection_lost_after_send'); } },
  });
  const response = await handleRequest(request('/v1/text/respond', { body: validBody() }), env);
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.error.code, 'provider_outcome_unknown');
  assert.equal(payload.error.retryable, false);
  assert.equal(guard.snapshot().totals.reservedTurns, 1);
  assert.equal(guard.snapshot().reservations[0].status, 'reserved');
});

test('gateway rejects output beyond the estimated ceiling and accounts for reported usage', async () => {
  const guard = new InMemoryBudgetGuard({
    limits: {
      monthlyTurnLimit: 10,
      conversationTurnLimit: 10,
      monthlyCharacterLimit: 1000,
      conversationCharacterLimit: 1000,
      monthlyCostHardLimitMicros: 1000,
      conversationCostHardLimitMicros: 1000,
    },
  });
  const env = await environment({
    BUDGET_GUARD: guard,
    TEXT_PROVIDER: {
      async fetch(_url, options) {
        const body = JSON.parse(options.body);
        return Response.json({
          schema_version: '0.1',
          turn_id: body.turn_id,
          output: { text: '長すぎる返答' },
          provider: { id: 'fake', model: 'fake-text' },
          usage: { output_units: 101, cost_micros: 120 },
        });
      },
    },
  });
  const response = await handleRequest(request('/v1/text/respond', { body: validBody() }), env);
  assert.equal(response.status, 502);
  assert.equal(guard.snapshot().totals.committedCostMicros, 120);
  assert.equal(guard.snapshot().reservations[0].actual_cost_micros, 120);
});

test('shared budget store serializes concurrent guards and survives guard replacement', async () => {
  const store = new InMemoryBudgetStore();
  const limits = {
    monthlyTurnLimit: 1,
    conversationTurnLimit: 1,
    monthlyCharacterLimit: 1000,
    conversationCharacterLimit: 1000,
    monthlyCostHardLimitMicros: 100,
    conversationCostHardLimitMicros: 100,
  };
  const now = () => new Date('2026-09-04T00:00:00.000Z');
  const firstGuard = new InMemoryBudgetGuard({
    limits, store, now, idFactory: () => 'reservation_shared',
  });
  const secondGuard = new InMemoryBudgetGuard({
    limits, store, now, idFactory: () => 'reservation_other',
  });
  const [first, second] = await Promise.all([
    firstGuard.authorize({
      conversation_id: 'conv_shared', turn_id: 'turn_1', input_characters: 10, estimated_cost_micros: 60,
    }),
    secondGuard.authorize({
      conversation_id: 'conv_shared', turn_id: 'turn_2', input_characters: 10, estimated_cost_micros: 60,
    }),
  ]);
  assert.equal([first, second].filter(result => result.allowed).length, 1);
  assert.equal([first, second].filter(result => !result.allowed).length, 1);

  const replacementGuard = new InMemoryBudgetGuard({ limits, store, now });
  const committed = await replacementGuard.commit({
    reservation_id: 'reservation_shared', usage: { cost_micros: 55 },
  });
  assert.equal(committed.ok, true);
  assert.equal(replacementGuard.snapshot().totals.committedCostMicros, 55);
});

test('Workers AI provider locks the approved model and normalizes its response', async () => {
  const model = '@cf/qwen/qwen3-30b-a3b-fp8';
  const calls = [];
  const body = validBody();
  body.execution = {
    provider_id: 'cloudflare-workers-ai',
    model_id: model,
    max_output_units: 120,
  };
  const response = await handleWorkersAIProvider(new Request('https://provider.test/respond', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), {
    WORKERS_AI_MODEL: model,
    AI: {
      async run(modelId, input) {
        calls.push({ modelId, input });
        return {
          response: '文字経路で続けます。',
          usage: { prompt_tokens: 25, completion_tokens: 9 },
        };
      },
    },
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.output.text, '文字経路で続けます。');
  assert.equal(payload.provider.model, model);
  assert.equal(payload.usage.output_units, 9);
  assert.equal(calls[0].input.max_tokens, 120);
  assert.equal(calls[0].input.messages.at(-1).content, '続きを進めよう');
});

test('Workers AI provider rejects silent model substitution before inference', async () => {
  let called = false;
  const body = validBody();
  body.execution = {
    provider_id: 'cloudflare-workers-ai',
    model_id: '@cf/other/model',
    max_output_units: 120,
  };
  const response = await handleWorkersAIProvider(new Request('https://provider.test/respond', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), {
    WORKERS_AI_MODEL: '@cf/qwen/qwen3-30b-a3b-fp8',
    AI: { async run() { called = true; return {}; } },
  });
  assert.equal(response.status, 409);
  assert.equal(called, false);
});
