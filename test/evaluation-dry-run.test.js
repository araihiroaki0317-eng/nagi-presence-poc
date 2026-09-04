import test from 'node:test';
import assert from 'node:assert/strict';
import { JAPANESE_CONVERSATION_CASES } from '../evaluation/japanese-conversation-cases.js';
import { buildEvaluationPlan, runMockEvaluation, seededRandom, unblindReviews } from '../evaluation/dry-run.js';

const candidates = [
  {
    provider_id: 'mock-a', model_id: 'mock-model-a', model_version: 'a-v1',
    baseline_prompt_version: 'core-v1', tuned_prompt_version: 'core-v1+a-tune-v1', context_version: 'ctx-v1',
  },
  {
    provider_id: 'mock-b', model_id: 'mock-model-b', model_version: 'b-v1',
    baseline_prompt_version: 'core-v1', tuned_prompt_version: 'core-v1+b-tune-v1', context_version: 'ctx-v1',
  },
];

test('evaluation plan runs every candidate in baseline and tuned variants with randomized order', () => {
  const plan = buildEvaluationPlan({
    cases: JAPANESE_CONVERSATION_CASES.slice(0, 2), candidates, random: seededRandom(42),
  });
  assert.equal(plan.length, 8);
  for (const caseId of JAPANESE_CONVERSATION_CASES.slice(0, 2).map(item => item.id)) {
    const tasks = plan.filter(task => task.case.id === caseId);
    assert.equal(tasks.filter(task => task.variant === 'baseline').length, 2);
    assert.equal(tasks.filter(task => task.variant === 'tuned').length, 2);
  }
});

test('full Mock A/B dry run produces audit records and blind review sheets without quality approval', async () => {
  let time = Date.parse('2026-09-04T00:00:00.000Z');
  const result = await runMockEvaluation({
    runId: 'dry_1',
    cases: JAPANESE_CONVERSATION_CASES,
    candidates,
    random: seededRandom(7),
    clock: () => (time += 50),
    invoke: async task => ({
      output_text: `[synthetic:${task.variant}] ${task.case.expected[0]}`,
      input_units: 10,
      output_units: 5,
    }),
  });
  assert.equal(result.records.length, JAPANESE_CONVERSATION_CASES.length * 4);
  assert.equal(result.review_sheets.length, result.records.length);
  assert.equal(result.quality_decision_allowed, false);
  assert.ok(result.records.every(record => record.usage.status === 'synthetic' && record.usage.cost_micros === null));
  const blindText = JSON.stringify(result.review_sheets);
  assert.doesNotMatch(blindText, /mock-a|mock-b|mock-model/);
  assert.ok(result.review_sheets.every(sheet => sheet.evaluation_status === 'awaiting_human_review'));
});

test('review results can be unblinded only through the separate identity map', async () => {
  const result = await runMockEvaluation({
    runId: 'dry_2', cases: JAPANESE_CONVERSATION_CASES.slice(0, 1), candidates,
    random: seededRandom(3),
    invoke: async task => ({ output_text: task.case.expected[0] }),
  });
  const reviews = result.review_sheets.map(sheet => ({
    sample_id: sheet.sample_id, candidate: sheet.candidate, weighted_score: 80,
  }));
  const unblinded = unblindReviews({ reviews, identityMap: result.identity_map });
  assert.ok(unblinded.every(row => row.provider_id && row.model_id));
  assert.throws(() => unblindReviews({
    reviews: [{ sample_id: 'unknown' }], identityMap: result.identity_map,
  }), /identity_missing_unknown/);
});
