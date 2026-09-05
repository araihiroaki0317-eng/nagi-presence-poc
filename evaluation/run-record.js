const FORBIDDEN_AUDIT_KEYS = new Set([
  'authorization', 'api_key', 'apikey', 'secret', 'token', 'cookie', 'internal_reasoning', 'chain_of_thought',
]);

function required(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function finiteNonNegative(value, code) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(code);
  return number;
}

function assertNoForbiddenKeys(value, path = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (FORBIDDEN_AUDIT_KEYS.has(normalized)) throw new Error(`forbidden_audit_field:${path}${key}`);
    assertNoForbiddenKeys(child, `${path}${key}.`);
  }
}

export function createAuditRecord(input = {}) {
  assertNoForbiddenKeys(input);
  const record = {
    schema_version: '0.1',
    record_type: 'provider_sample',
    run_id: required(input.run_id, 'run_id_required'),
    sample_id: required(input.sample_id, 'sample_id_required'),
    case_id: required(input.case_id, 'case_id_required'),
    variant: required(input.variant, 'variant_required'),
    provider_id: required(input.provider_id, 'provider_id_required'),
    model_id: required(input.model_id, 'model_id_required'),
    model_version: required(input.model_version, 'model_version_required'),
    prompt_version: required(input.prompt_version, 'prompt_version_required'),
    context_version: required(input.context_version, 'context_version_required'),
    context_source_ids: Array.isArray(input.context_source_ids) ? [...input.context_source_ids] : [],
    conversation_id: required(input.conversation_id, 'conversation_id_required'),
    turn_id: required(input.turn_id, 'turn_id_required'),
    input_text: required(input.input_text, 'input_text_required'),
    output_text: required(input.output_text, 'output_text_required'),
    started_at: required(input.started_at, 'started_at_required'),
    completed_at: required(input.completed_at, 'completed_at_required'),
    latency_ms: finiteNonNegative(input.latency_ms, 'latency_ms_invalid'),
    usage: {
      status: required(input.usage?.status, 'usage_status_required'),
      input_units: finiteNonNegative(input.usage?.input_units, 'input_units_invalid'),
      output_units: finiteNonNegative(input.usage?.output_units, 'output_units_invalid'),
      cost_micros: input.usage?.cost_micros == null
        ? null
        : finiteNonNegative(input.usage.cost_micros, 'cost_micros_invalid'),
      currency: input.usage?.currency ? String(input.usage.currency) : null,
    },
  };
  return Object.freeze(record);
}

function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

export function createBlindReviewBundle(records, { aliases = ['A', 'B', 'C', 'D'], random = Math.random } = {}) {
  if (!Array.isArray(records) || records.length === 0) throw new Error('records_required');
  const identities = [...new Set(records.map(record => `${record.provider_id}\u0000${record.model_id}\u0000${record.model_version}`))];
  if (identities.length > aliases.length) throw new Error('insufficient_blind_aliases');
  const identityToAlias = new Map(shuffled(identities.sort(), random).map((identity, index) => [identity, aliases[index]]));
  const key = record => `${record.provider_id}\u0000${record.model_id}\u0000${record.model_version}`;

  const review_packets = records.map(record => Object.freeze({
    schema_version: '0.1',
    record_type: 'blind_review_sample',
    run_id: record.run_id,
    sample_id: record.sample_id,
    case_id: record.case_id,
    variant: record.variant,
    candidate: identityToAlias.get(key(record)),
    input_text: record.input_text,
    output_text: record.output_text,
  }));
  const identity_map = records.map(record => ({
    sample_id: record.sample_id,
    candidate: identityToAlias.get(key(record)),
    provider_id: record.provider_id,
    model_id: record.model_id,
    model_version: record.model_version,
  }));
  return Object.freeze({ review_packets, identity_map });
}

export function createAnalysisRecord(input = {}) {
  return Object.freeze({
    schema_version: '0.1',
    record_type: 'human_review',
    run_id: required(input.run_id, 'run_id_required'),
    sample_id: required(input.sample_id, 'sample_id_required'),
    reviewer_id: required(input.reviewer_id, 'reviewer_id_required'),
    candidate: required(input.candidate, 'candidate_required'),
    ratings: structuredClone(input.ratings || {}),
    hard_gate_pass: input.hard_gate_pass === true,
    notes: String(input.notes || ''),
    reviewed_at: required(input.reviewed_at, 'reviewed_at_required'),
  });
}

export function toNDJSON(records) {
  if (!Array.isArray(records)) throw new Error('records_required');
  return records.map(record => JSON.stringify(record)).join('\n');
}
