import { createTextGatewayRequest } from '../gateway/text-protocol.js';
import { contextForEvaluationCase, BASELINE_PROMPT_VERSION } from './baseline-prompt.js';

export function buildApprovedBaselineManifest({ envelope, cases, runId }) {
  const caseById = new Map(cases.map(item => [item.id, item]));
  return envelope.case_ids.map((caseId, index) => {
    const item = caseById.get(caseId);
    if (!item) throw new Error(`approved_case_missing_${caseId}`);
    return Object.freeze({
      case_id: caseId,
      provider_id: envelope.provider_id,
      model_id: envelope.model_id,
      variant: envelope.evaluation_variant,
      prompt_version: BASELINE_PROMPT_VERSION,
      max_output_units: envelope.max_output_units_per_request,
      retry_limit: envelope.automatic_retry_limit,
      request: createTextGatewayRequest({
        conversationId: `${runId}_${caseId}`,
        turnId: `${runId}_${caseId}_baseline`,
        context: contextForEvaluationCase(item),
        input: { content: item.user_turns.join('\n'), channel: 'text' },
      }),
    });
  });
}
