import test from 'node:test';
import assert from 'node:assert/strict';
import cloudflareWorker from '../conversation-gateway/cloudflare-entry.js';
import { BudgetLedger, DeviceAuthLedger } from '../conversation-gateway/cloudflare-entry.js';
import { sha256Hex } from '../conversation-gateway/auth.js';
import { DEVICE_AUTH_LIMITS } from '../conversation-gateway/device-auth-ledger.js';

class FakeStorage {
  constructor() { this.values = new Map(); this.queue = Promise.resolve(); }
  get(key) { return this.values.get(key); }
  put(key, value) { this.values.set(key, structuredClone(value)); }
  delete(key) { this.values.delete(key); }
  transaction(operation) {
    const next = this.queue.then(() => operation(this));
    this.queue = next.catch(() => {});
    return next;
  }
}

function request(turn, token = 'device-test-token') {
  return new Request('https://gateway.test/v1/text/respond', {
    method: 'POST',
    headers: {
      Origin: 'https://araihiroaki0317-eng.github.io',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      schema_version: '0.1', conversation_id: `conv_${turn}`, turn_id: `turn_${turn}`,
      context: 'Tiny Nagi Core', input: { type: 'text', content: 'OK', channel: 'text' },
      output_channels: ['text'],
    }),
  });
}

function pairingRequest(code) {
  return new Request('https://gateway.test/v1/pairing/redeem', {
    method: 'POST',
    headers: {
      Origin: 'https://araihiroaki0317-eng.github.io',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ code }),
  });
}

async function environment() {
  const ledger = new BudgetLedger({ storage: new FakeStorage() }, {});
  return {
    ALLOWED_ORIGIN: 'https://araihiroaki0317-eng.github.io',
    DEVICE_TOKEN_SHA256: await sha256Hex('device-test-token'),
    WORKERS_AI_MODEL: '@cf/qwen/qwen3-30b-a3b-fp8',
    BUDGET_LEDGER: { getByName: () => ledger },
    AI: {
      async run(_model, input) {
        return {
          response: `応答:${input.messages.at(-1).content}`,
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      },
    },
  };
}

test('single Cloudflare entry composes auth, durable budget, estimator, and Workers AI', async () => {
  const env = await environment();
  const response = await cloudflareWorker.fetch(request(1), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.output.text, '応答:OK');
  assert.equal(payload.provider.id, 'cloudflare-workers-ai');
  assert.equal(payload.gateway_budget.status, 'committed');
});

test('durable ledger enforces the twelve-request envelope across Worker calls', async () => {
  const env = await environment();
  const responses = [];
  for (let turn = 1; turn <= 13; turn += 1) {
    responses.push(await cloudflareWorker.fetch(request(turn), env));
  }
  assert.ok(responses.slice(0, 12).every(response => response.status === 200));
  assert.equal(responses[12].status, 429);
  assert.equal((await responses[12].json()).error.limit_reason, 'monthly_turn_limit');
});

test('device auth ledger redeems a code once and expires the hashed token', async () => {
  let current = Date.parse('2026-09-04T00:00:00.000Z');
  const storage = new FakeStorage();
  const code = 'pair-123456';
  const token = 'fixed-device-token';
  const ledger = new DeviceAuthLedger({ storage }, {
    PAIRING_CODE_SHA256: await sha256Hex(code),
    PAIRING_CODE_ISSUED_AT: '2026-09-04T00:00:00.000Z',
    PAIRING_CODE_EXPIRES_AT: '2026-09-04T00:10:00.000Z',
  }, { now: () => current, tokenFactory: () => token });

  const redeemed = await ledger.fetch(new Request('https://auth.internal/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  }));
  assert.equal(redeemed.status, 200);
  const issued = await redeemed.json();
  assert.equal(issued.token, token);
  assert.equal(Date.parse(issued.expires_at) - current, DEVICE_AUTH_LIMITS.deviceTokenTtlMs);

  const verified = await ledger.fetch(new Request('https://auth.internal/verify', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  }));
  assert.equal(verified.status, 200);
  const reused = await ledger.fetch(new Request('https://auth.internal/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  }));
  assert.equal(reused.status, 409);
  assert.equal((await reused.json()).error.code, 'pairing_code_used');
  assert.equal(JSON.stringify([...storage.values]).includes(code), false);
  assert.equal(JSON.stringify([...storage.values]).includes(token), false);

  current += DEVICE_AUTH_LIMITS.deviceTokenTtlMs;
  const expired = await ledger.fetch(new Request('https://auth.internal/verify', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  }));
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).reason, 'device_token_expired');
});

test('device auth ledger locks a pairing code after five failed attempts', async () => {
  const storage = new FakeStorage();
  const ledger = new DeviceAuthLedger({ storage }, {
    PAIRING_CODE_SHA256: await sha256Hex('correct-code'),
    PAIRING_CODE_ISSUED_AT: '2026-09-04T00:00:00.000Z',
    PAIRING_CODE_EXPIRES_AT: '2026-09-04T00:10:00.000Z',
  }, { now: () => Date.parse('2026-09-04T00:05:00.000Z'), tokenFactory: () => 'unused-token' });

  let response;
  for (let attempt = 0; attempt < DEVICE_AUTH_LIMITS.maxPairingFailures; attempt += 1) {
    response = await ledger.fetch(new Request('https://auth.internal/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'wrong-code' }),
    }));
  }
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, 'pairing_locked');
  const blockedCorrectCode = await ledger.fetch(new Request('https://auth.internal/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'correct-code' }),
  }));
  assert.equal(blockedCorrectCode.status, 429);
});

test('Cloudflare entry accepts a paired token before any model call', async () => {
  const env = await environment();
  const code = 'pair-654321';
  const authLedger = new DeviceAuthLedger({ storage: new FakeStorage() }, {
    PAIRING_CODE_SHA256: await sha256Hex(code),
    PAIRING_CODE_ISSUED_AT: new Date(Date.now() - 1000).toISOString(),
    PAIRING_CODE_EXPIRES_AT: new Date(Date.now() + 9 * 60 * 1000).toISOString(),
  });
  env.DEVICE_AUTH_LEDGER = { getByName: () => authLedger };
  const paired = await cloudflareWorker.fetch(pairingRequest(code), env);
  assert.equal(paired.status, 200);
  assert.equal(paired.headers.get('Cache-Control'), 'no-store');
  const { token } = await paired.json();

  const response = await cloudflareWorker.fetch(request(100, token), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).output.text, '応答:OK');
});

test('invalid paired credentials stop before Workers AI is called', async () => {
  const env = await environment();
  let modelCalls = 0;
  const pairingCodeDigest = await sha256Hex('unused-code');
  env.AI.run = async () => { modelCalls += 1; return { response: '呼ばれない' }; };
  env.DEVICE_AUTH_LEDGER = {
    getByName: () => new DeviceAuthLedger({ storage: new FakeStorage() }, {
      PAIRING_CODE_SHA256: pairingCodeDigest,
      PAIRING_CODE_ISSUED_AT: new Date(Date.now() - 1000).toISOString(),
      PAIRING_CODE_EXPIRES_AT: new Date(Date.now() + 9 * 60 * 1000).toISOString(),
    }),
  };

  const response = await cloudflareWorker.fetch(request(101, 'invalid-device-token'), env);
  assert.equal(response.status, 401);
  assert.equal(modelCalls, 0);
});
