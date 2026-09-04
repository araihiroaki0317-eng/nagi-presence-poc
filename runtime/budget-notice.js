const HARD_LIMIT_CODES = new Set(['budget_limit', 'budget_hard_limit', 'provider_quota', 'credit_exhausted']);

export function budgetNoticeFromEvent(event = {}) {
  if (event.type !== 'budget.soft_limit') return null;
  const reasons = Array.isArray(event.payload?.reasons) ? event.payload.reasons : [];
  return Object.freeze({
    severity: 'soft',
    code: 'budget_soft_limit',
    reasons,
    paidRouteAllowed: true,
    requiresDecision: true,
    message: '利用枠が少なくなっています。会話は続けられます。',
  });
}

export function budgetNoticeFromError(error = {}) {
  const code = String(error.code || '').trim();
  const message = String(error.message || '').toLowerCase();
  const looksLikeQuota = message.includes('quota') || message.includes('credit') || message.includes('利用枠');
  if (!HARD_LIMIT_CODES.has(code) && !looksLikeQuota) return null;
  return Object.freeze({
    severity: 'hard',
    code: code || 'provider_quota',
    reasons: error.limitReason ? [error.limitReason] : [],
    paidRouteAllowed: false,
    requiresDecision: true,
    message: '承認済みの利用枠に達したため、有料経路を停止しました。',
  });
}
