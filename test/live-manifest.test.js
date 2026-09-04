import test from 'node:test';
import assert from 'node:assert/strict';
import { JAPANESE_CONVERSATION_CASES } from '../evaluation/japanese-conversation-cases.js';
import { APPROVED_WORKERS_AI_BASELINE_ENVELOPE as envelope } from '../evaluation/approved-envelope-workers-ai-baseline-v1.js';
import { buildApprovedBaselineManifest } from '../evaluation/live-manifest.js';
import { authorizeLiveEvaluationPlan } from '../evaluation/live-run-policy.js';
import { estimateWorkersAICost, handleWorkersAICostEstimate } from '../conversation-gateway/workers-ai-cost-estimator.js';

test('approved manifest contains exactly twelve fixed baseline requests', () => {
  const manifest = buildApprovedBaselineManifest({
    envelope, cases: JAPANESE_CONVERSATION_CASES, runId: 'live_candidate_1',
  });
  assert.equal(manifest.length, 12);
  assert.ok(manifest.every(task => task.variant === 'baseline'));
  assert.ok(manifest.every(task => task.max_output_units === 300 && task.retry_limit === 0));
  assert.ok(manifest.every(task => task.request.context.includes('[prompt_version:tiny-nagi-core-eval-v0.1]')));
  assert.equal(new Set(manifest.map(task => task.request.conversation_id)).size, 12);
});

test('conservative manifest estimate remains inside the approved one-cent envelope', () => {
  const manifest = buildApprovedBaselineManifest({
    envelope, cases: JAPANESE_CONVERSATION_CASES, runId: 'live_candidate_1',
  });
  const total = manifest.reduce((sum, task) => sum + estimateWorkersAICost({
    input_characters: task.request.input.content.length,
    context_characters: task.request.context.length,
  }).estimated_cost_micros, 0);
  const authorized = authorizeLiveEvaluationPlan({ envelope, tasks: manifest, estimatedTotalCostMicros: total });
  assert.equal(authorized.allowed, true);
  assert.ok(total <= 10000);
});

test('cost estimator binding locks provider, model, output ceiling, and price provenance', async () => {
  const response = await handleWorkersAICostEstimate(new Request('https://cost.test/estimate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input_characters: 20, context_characters: 1000 }),
  }));
  assert.equal(response.status, 200);
  const estimate = await response.json();
  assert.equal(estimate.provider_id, envelope.provider_id);
  assert.equal(estimate.model_id, envelope.model_id);
  assert.equal(estimate.max_output_units, 300);
  assert.equal(estimate.estimate_kind, 'conservative_not_billed');
  assert.equal(estimate.price_source_date, '2026-09-04');
});
