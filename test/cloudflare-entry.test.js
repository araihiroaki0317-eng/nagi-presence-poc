import test from 'node:test';
import assert from 'node:assert/strict';
import cloudflareWorker from '../conversation-gateway/cloudflare-entry.js';
import { BudgetLedger } from '../conversation-gateway/cloudflare-entry.js';
import { sha256Hex } from '../conversation-gateway/auth.js';

class FakeStorage {
  constructor() { this.values = new Map(); this.queue = Promise.resolve(); }
  get(key) { return this.values.get(key); }
  put(key, value) { this.values.set(key, structuredClone(value)); }
  transaction(operation) {
    const next = this.queue.then(() => operation(this));
    this.queue = next.catch(() => {});
    return next;
  }
}

function request(turn) {
  return new Request('https://gateway.test/v1/text/respond', {
    method: 'POST',
    headers: {
      Origin: 'https://araihiroaki0317-eng.github.io',
      Authorization: 'Bearer device-test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      schema_version: '0.1', conversation_id: `conv_${turn}`, turn_id: `turn_${turn}`,
      context: 'Tiny Nagi Core', input: { type: 'text', content: 'OK', channel: 'text' },
      output_channels: ['text'],
    }),
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
