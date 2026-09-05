import test from 'node:test';
import assert from 'node:assert/strict';
import { APPROVED_WORKERS_AI_BASELINE_ENVELOPE as envelope } from '../evaluation/approved-envelope-workers-ai-baseline-v1.js';
import { authorizeLiveEvaluationPlan } from '../evaluation/live-run-policy.js';

function tasks() {
  return envelope.case_ids.map(caseId => ({
    case_id: caseId,
    provider_id: envelope.provider_id,
    model_id: envelope.model_id,
    variant: 'baseline',
    max_output_units: 300,
    retry_limit: 0,
  }));
}

test('explicitly approved Workers AI baseline plan is authorized within one cent', () => {
  const result = authorizeLiveEvaluationPlan({ envelope, tasks: tasks(), estimatedTotalCostMicros: 9000 });
  assert.equal(result.allowed, true);
  assert.equal(result.authorized_requests, 12);
  assert.equal(result.envelope_id, envelope.envelope_id);
});

test('live plan rejects extra calls, output, cost, retries, and substitutions', () => {
  assert.equal(authorizeLiveEvaluationPlan({
    envelope, tasks: [...tasks(), tasks()[0]], estimatedTotalCostMicros: 9000,
  }).reason, 'request_limit');
  const oversized = tasks(); oversized[0] = { ...oversized[0], max_output_units: 301 };
  assert.equal(authorizeLiveEvaluationPlan({ envelope, tasks: oversized, estimatedTotalCostMicros: 9000 }).reason, 'output_limit');
  assert.equal(authorizeLiveEvaluationPlan({ envelope, tasks: tasks(), estimatedTotalCostMicros: 10001 }).reason, 'cost_hard_limit');
  const retried = tasks(); retried[0] = { ...retried[0], retry_limit: 1 };
  assert.equal(authorizeLiveEvaluationPlan({ envelope, tasks: retried, estimatedTotalCostMicros: 9000 }).reason, 'retry_limit');
  const substituted = tasks(); substituted[0] = { ...substituted[0], model_id: '@cf/other/model' };
  assert.equal(authorizeLiveEvaluationPlan({ envelope, tasks: substituted, estimatedTotalCostMicros: 9000 }).reason, 'model_mismatch');
});

test('deployment and browser operation remain outside the approved envelope', () => {
  assert.equal(envelope.allow_deployment, false);
  assert.equal(envelope.allow_browser_operation, false);
  assert.equal(envelope.allow_provider_substitution, false);
  assert.equal(envelope.allow_model_substitution, false);
});
