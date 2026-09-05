import { createAuditRecord, createBlindReviewBundle } from './run-record.js';

function requiredArray(value, code) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(code);
  return value;
}

export function seededRandom(seed = 1) {
  let state = Number(seed) >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function shuffle(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

export function buildEvaluationPlan({ cases, candidates, random = Math.random }) {
  requiredArray(cases, 'cases_required');
  requiredArray(candidates, 'candidates_required');
  const tasks = [];
  for (const item of cases) {
    for (const variant of ['baseline', 'tuned']) {
      for (const candidate of shuffle(candidates, random)) {
        tasks.push(Object.freeze({ case: item, candidate, variant }));
      }
    }
  }
  return tasks;
}

export async function runMockEvaluation({
  runId,
  cases,
  candidates,
  invoke,
  random = seededRandom(1),
  clock = (() => { let value = 0; return () => value += 100; })(),
} = {}) {
  if (typeof invoke !== 'function') throw new Error('invoke_required');
  const plan = buildEvaluationPlan({ cases, candidates, random });
  const records = [];
  for (let index = 0; index < plan.length; index += 1) {
    const task = plan[index];
    const started = clock();
    const result = await invoke(task);
    const completed = clock();
    records.push(createAuditRecord({
      run_id: runId,
      sample_id: `${runId}_sample_${String(index + 1).padStart(3, '0')}`,
      case_id: task.case.id,
      variant: task.variant,
      provider_id: task.candidate.provider_id,
      model_id: task.candidate.model_id,
      model_version: task.candidate.model_version,
      prompt_version: task.variant === 'baseline'
        ? task.candidate.baseline_prompt_version
        : task.candidate.tuned_prompt_version,
      context_version: task.candidate.context_version,
      context_source_ids: [`case:${task.case.id}`],
      conversation_id: `${runId}_${task.case.id}`,
      turn_id: `${runId}_${task.case.id}_${task.variant}_${task.candidate.provider_id}`,
      input_text: task.case.user_turns.join('\n'),
      output_text: result.output_text,
      started_at: new Date(started).toISOString(),
      completed_at: new Date(completed).toISOString(),
      latency_ms: completed - started,
      usage: {
        status: 'synthetic',
        input_units: result.input_units || 0,
        output_units: result.output_units || 0,
        cost_micros: null,
        currency: null,
      },
    }));
  }

  const blind = createBlindReviewBundle(records, { random });
  const caseById = new Map(cases.map(item => [item.id, item]));
  const review_sheets = blind.review_packets.map(packet => {
    const item = caseById.get(packet.case_id);
    return Object.freeze({
      ...packet,
      expected: [...item.expected],
      forbidden: [...item.forbidden],
      dimensions: [...item.dimensions],
      hard_gate: item.hard_gate,
      evaluation_status: 'awaiting_human_review',
    });
  });
  return Object.freeze({
    run_id: runId,
    run_kind: 'synthetic_dry_run',
    quality_decision_allowed: false,
    records,
    review_sheets,
    identity_map: blind.identity_map,
  });
}

export function unblindReviews({ reviews, identityMap }) {
  const identities = new Map(identityMap.map(item => [item.sample_id, item]));
  return reviews.map(review => {
    const identity = identities.get(review.sample_id);
    if (!identity) throw new Error(`identity_missing_${review.sample_id}`);
    return Object.freeze({ ...review, ...identity });
  });
}
