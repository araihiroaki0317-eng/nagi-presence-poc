import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAnalysisRecord,
  createAuditRecord,
  createBlindReviewBundle,
  toNDJSON,
} from '../evaluation/run-record.js';

function sample(overrides = {}) {
  return createAuditRecord({
    run_id: 'run_1', sample_id: 'sample_1', case_id: 'listen_without_fixing', variant: 'baseline',
    provider_id: 'provider-a', model_id: 'model-a', model_version: 'model-a-2026-09-01',
    prompt_version: 'tiny-nagi-core-v0.1', context_version: 'eval-context-v0.1',
    context_source_ids: ['case:listen_without_fixing'],
    conversation_id: 'conv_1', turn_id: 'turn_1',
    input_text: '今日はしんどかった。', output_text: 'うん。今日は大変だったんだね。',
    started_at: '2026-09-04T00:00:00.000Z', completed_at: '2026-09-04T00:00:00.320Z',
    latency_ms: 320,
    usage: { status: 'reported', input_units: 120, output_units: 18, cost_micros: 42, currency: 'USD' },
    ...overrides,
  });
}

test('audit record retains provenance and measured usage without analysis', () => {
  const record = sample();
  assert.equal(record.model_version, 'model-a-2026-09-01');
  assert.equal(record.prompt_version, 'tiny-nagi-core-v0.1');
  assert.equal(record.usage.cost_micros, 42);
  assert.equal('ratings' in record, false);
  assert.equal('inferred_emotion' in record, false);
});

test('audit record rejects secrets and internal reasoning at any depth', () => {
  assert.throws(() => sample({ authorization: 'Bearer secret' }), /forbidden_audit_field/);
  assert.throws(() => sample({ metadata: { internal_reasoning: 'hidden' } }), /forbidden_audit_field/);
});

test('blind packet hides provider identity, model, usage, latency, and context provenance', () => {
  const second = sample({
    sample_id: 'sample_2', provider_id: 'provider-b', model_id: 'model-b', model_version: 'model-b-v1',
    output_text: '今日は大変だったね。',
  });
  const bundle = createBlindReviewBundle([sample(), second], { random: () => 0.999 });
  const serialized = JSON.stringify(bundle.review_packets);
  assert.doesNotMatch(serialized, /provider-a|provider-b|model-a|model-b/);
  assert.doesNotMatch(serialized, /cost_micros|latency_ms|context_source_ids/);
  assert.deepEqual(bundle.review_packets.map(packet => packet.candidate), ['A', 'B']);
  assert.equal(bundle.identity_map[0].provider_id, 'provider-a');
});

test('human analysis is a separate record and NDJSON preserves row boundaries', () => {
  const audit = sample();
  const analysis = createAnalysisRecord({
    run_id: 'run_1', sample_id: 'sample_1', reviewer_id: 'reviewer_hiro', candidate: 'A',
    ratings: { naturalness: 4, persona: 4 }, hard_gate_pass: true,
    notes: '自然だが少し説明的。', reviewed_at: '2026-09-04T01:00:00.000Z',
  });
  assert.equal(analysis.record_type, 'human_review');
  assert.equal('provider_id' in analysis, false);
  const rows = toNDJSON([audit, analysis]).split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.record_type), ['provider_sample', 'human_review']);
});
