# Japanese conversation evaluation

This fixed set compares text providers without teaching to a single model answer.

## Separation of evidence

- Automated invariants: conversation identity, checkpoint continuity, duplicate turns, paid retries, provider/model binding.
- Human ratings: Japanese naturalness, Nagi continuity, context handling, judgment, and concision.
- Optional expression: playful or shadow-like wording is never required. The evaluator checks only whether it remains contextual and non-coercive.

## Run order

1. Use the same Tiny Nagi Core, context pack, temperature, output ceiling, and cases for every provider.
2. Randomize provider labels before human review.
3. Record raw request/response, latency, token usage, model snapshot, and prompt version.
4. Score each listed dimension from 1 to 5 and mark every hard gate pass/fail.
5. Reject any provider with a hard failure, naturalness below 4/5, or weighted score below 75/100.
6. A more expensive provider is justified only when its weighted score is at least 10 points higher.

Do not run real providers until provider/model/scope/budget are explicitly approved.

## Record separation

- `provider_sample`: append-only audit record with raw text, timestamps, versions, identity, measured usage, and latency. It contains no ratings or inferred emotion.
- `blind_review_sample`: reviewer packet with provider/model identity and cost/latency removed.
- `human_review`: separate analysis record. It never rewrites the provider sample.
- `identity_map`: kept outside the reviewer packet and used only after scoring.

Never include request headers, API keys, bearer tokens, cookies, internal reasoning, or raw audio in these records.

## Synthetic dry run

The dry runner executes every case for candidate A/B in both `baseline` and `tuned` variants. Candidate order and blind aliases are randomized. Its usage is marked `synthetic`, cost is `null`, and `quality_decision_allowed` is always `false`. A dry run validates workflow only; it cannot approve a provider.
