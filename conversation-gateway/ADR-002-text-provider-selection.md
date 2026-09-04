# ADR-002: Independent text provider shortlist

- Status: Proposed, local implementation only
- Date: 2026-09-04

## Decision

Evaluate Cloudflare Workers AI first as the independent text route. Use OpenAI GPT-5 Mini as the quality-control candidate if the Workers AI model fails the Japanese conversation gate.

No production provider is approved by this ADR. Credentials, deployment, paid requests, and a production spending envelope require Hiro's explicit approval.

## Why this order

1. The existing backend boundary is Cloudflare Workers, so Workers AI can be called through a server-side binding without placing a provider key in the browser.
2. Workers AI includes 10,000 Neurons per day at no charge; excess usage is metered. This is a useful PoC cost floor, not evidence of conversation quality.
3. Cloudflare states that Workers AI customer content is not used to train models or improve Cloudflare or third-party services without explicit consent.
4. GPT-5 Mini provides a stronger quality-control candidate at published text pricing of USD 0.25/M input tokens and USD 2.00/M output tokens.
5. Gemini unpaid services are not selected for personal conversation testing because Google's current terms allow submitted content and responses to be used for product improvement and human review. Paid Gemini remains a possible later candidate.

## Initial Workers AI candidate

`@cf/qwen/qwen3-30b-a3b-fp8`

Published price: USD 0.051/M input tokens and USD 0.34/M output tokens. Its Japanese personality quality is unverified and must not be inferred from multilingual claims or price.

## Quality gate

Run the same fixed Japanese conversation set against Workers AI and GPT-5 Mini.

- Japanese naturalness: at least 4/5
- Nagi persona continuity: no reset or generic assistant drift
- Context recovery: no duplicated greeting or lost topic
- Timing: first visible text and complete response measured separately
- Safety: same `conversation_id`, fixed model ID, output ceiling, no silent retry or substitution

Workers AI is rejected as the primary text route if it misses a hard gate. A more expensive route is justified only if the combined Japanese naturalness, timing, and personality score improves by at least 10 weighted points.

## Cost comparison rule

Use actual billed usage for the decision. Estimate 10/30/60 minutes per day only after measuring tokens per real Japanese conversation. Do not extrapolate from English token counts or list price alone.

## Sources checked 2026-09-04

- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developers.cloudflare.com/workers-ai/platform/data-usage/
- https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/
- https://developers.openai.com/api/docs/models/gpt-5-mini
- https://ai.google.dev/gemini-api/terms
- https://ai.google.dev/gemini-api/docs/pricing
