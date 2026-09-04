export function authorizeLiveEvaluationPlan({ envelope, tasks, estimatedTotalCostMicros }) {
  if (envelope?.status !== 'approved' || envelope.approval_source !== 'explicit_user') {
    return { allowed: false, reason: 'explicit_envelope_required' };
  }
  if (!Array.isArray(tasks) || tasks.length === 0) return { allowed: false, reason: 'tasks_required' };
  if (tasks.length > envelope.request_limit) return { allowed: false, reason: 'request_limit' };
  if (!Number.isSafeInteger(estimatedTotalCostMicros) || estimatedTotalCostMicros < 0) {
    return { allowed: false, reason: 'trusted_cost_estimate_required' };
  }
  if (estimatedTotalCostMicros > envelope.hard_limit_micros) {
    return { allowed: false, reason: 'cost_hard_limit' };
  }

  const approvedCases = new Set(envelope.case_ids);
  for (const task of tasks) {
    if (task.provider_id !== envelope.provider_id) return { allowed: false, reason: 'provider_mismatch' };
    if (task.model_id !== envelope.model_id) return { allowed: false, reason: 'model_mismatch' };
    if (task.variant !== envelope.evaluation_variant) return { allowed: false, reason: 'variant_mismatch' };
    if (!approvedCases.has(task.case_id)) return { allowed: false, reason: 'case_not_approved' };
    if (!Number.isSafeInteger(task.max_output_units)
      || task.max_output_units <= 0
      || task.max_output_units > envelope.max_output_units_per_request) {
      return { allowed: false, reason: 'output_limit' };
    }
    if (Number(task.retry_limit || 0) > envelope.automatic_retry_limit) {
      return { allowed: false, reason: 'retry_limit' };
    }
  }
  return {
    allowed: true,
    envelope_id: envelope.envelope_id,
    authorized_requests: tasks.length,
    reserved_cost_micros: estimatedTotalCostMicros,
  };
}
