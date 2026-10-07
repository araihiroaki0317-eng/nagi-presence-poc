# 凪 Web ver1 — release contract

Decision: 2026-10-04 JST. User agreed ver1 is a Web app opened explicitly for personal conversation. Next milestones are resident presence, then multi-participant conversation (Hiro, CreO, Nagi, Gen); VR is a future direction.

## Milestones and gates

| Milestone | Acceptance | State |
|---|---|---|
| M0 avatar integration PoC | Nagi image, user speech, Memory/LLM, ElevenLabs voice, lip sync | Passed by device reports; body sway/expression remain known issues |
| M1 ver1 scope and baseline | Preserve accepted voice and synchronous memory, document bounded session/costs | Completed |
| M2 Web release candidate | 5-minute session, bounded reply grace, visible remaining time, fixed avatar and scrolling transcript, explicit stop/retry, startup diagnostics | Deployed in PR #45; final adjustment deployed in PR #46 |
| M3 device acceptance | Two 5-minute conversations; automatic ending after reply; stop/restart; text input; next-session recall of a harmless fact; no recurring onset repetition/stall | User accepted latest device experience Oct 7: 大丈夫そうだね. Individual checklist items not all separately reported |
| M4 ver1 release | Record M3 outcomes and known limits; complete account cost review; remove candidate label and create immutable version tag | Personal Web ver1 approved Oct 7; release metadata publication in this change |

No new feature work outside this contract before release. Five minutes is the initial bounded-session policy, not a vendor limit. On expiration stop accepting input; allow current work up to 60 seconds, then force cleanup. A hung reply may therefore be cut at the hard deadline. Manual stop and leaving the screen are immediate.

Startup target: <=15 seconds from permission-complete to greeting playback notification on both acceptance runs. This is provisional; if missed, document whether provider capacity/startup can be improved within existing integration or explicitly revise the release criterion with user. Provider playback notification is not proof of the exact first audible sample. Diagnostics separate permission, verify, prepare, start and greeting request. Do not claim timing improvement from one run.

## Baseline

Accepted baseline: presence PR #44, commit 9215854000d7cd2c9e5ef182df5e28e8aaaf5849. Avatar A17VAN5175, Essence 2; 16 kHz mono PCM; 160 ms silence once per reply. Keep ElevenLabs voice/model/tuning. Memory deferLearning experiment is off. Oct 4 07:42 user report: not bad. Latest 90-second log: track attach 13.363 s, greeting playback 1.964 s after TTS request, ordinary playback 1.074-1.907 s, Memory 2.731-4.837 s. Final playback_not_confirmed coincided with automatic expiration; not proven audio failure.

## Known limitations and ver1 exclusions

- Repetitive body sway and warmer expression: inquiry sent Oct 3 to hello@bithuman.ai, thread 1a0fef8484b1270d. No answer as of Oct 4 07:44. No paid regeneration/overwrite authorized. User acceptance of current appearance required for ver1.
- No speaker identity, reliable distinction from nearby voices, reply interruption or background listening.
- Web requires foreground use. Screen departure ends session. Native app, PWA installation, residence and multi-party orchestration are not ver1 requirements.
- Transcript is displayed per page lifetime; Memory persists server-side. This is not an archived chat-history browser.
- Origin restriction is not user authentication. URL is public; this is personal-use release only, not a public multi-user product. Do not claim access is private or CORS prevents deliberate API abuse. Public distribution requires a separate access decision.
- Cleanup failure retains the scoped control token for retry; never declare provider ended when acknowledgment is false.

## Components and costs (Keep / Replace / Retire proposal)

| Component | Role / decision | Confirmed cost or remaining verification |
|---|---|---|
| bitHuman Creator | Keep: avatar-only cloud Essence 2 | User reported $20/month. Official 2,000 credits/month, 4 credits/min while running, including silence. 5 min =20 credits/$0.20; 6 min =24/$0.24; startup time may add usage. Remaining balance unknown. 500 cloud minutes assumes all credits available, no creation use. |
| ElevenLabs | Keep: existing TTS voice and Scribe STT | Current account plan, credit balance, model-specific TTS rate and excess billing not verified; do not present a total. |
| Memory Worker, Mem0, Zep, OpenAI | Keep for ver1; review duplication later | Runtime uses Responses API, not the ChatGPT subscription. Actual plans/model billing and usage unknown. No removal before recall acceptance. |
| LiveKit Cloud | Keep: media room transport | Actual plan/quotas/bandwidth usage unknown. No new deployed conversation agent introduced. |
| GitHub Pages / Cloudflare | Keep: existing UI and Workers | Actual account plans/usage unknown. |
| LiveAvatar / Spatius | Retire candidates for Nagi path | Not used by current avatar. Billing/subscription status not verified; do not delete secrets or cancel automatically. |
| ChatGPT / Notion | Development and project record tools | Not the live Nagi inference provider; account subscriptions are not all Nagi runtime costs. |
| Genspark / Gemini | Outside current Nagi runtime | Not charged to this runtime estimate. |

Official sources checked 2026-10-04: https://docs.bithuman.ai/pricing ; https://elevenlabs.io/pricing/api ; https://docs.livekit.io/deploy/admin/billing/ . Account-specific monthly total remains unknown. No plan change, top-up or paid avatar regeneration in this work.

## Release checklist

- [ ] Worker health reports max_session_seconds=300 after deploy.
- [ ] Branch tests and Pages deploy pass; published assets match changes.
- [ ] M3 device evaluation completes; end acknowledgments true and restart works.
- [ ] Current appearance accepted as a known limitation.
- [ ] Account billing/usage review completed or explicitly accepted as an unresolved budget limitation.
- [ ] Release label and version tag created only after acceptance.


## 2026-10-06 final turn-taking adjustment

User device report: conversation is otherwise good; short hesitation still causes premature response. Increase Scribe VAD silence commit threshold from 1.0 to 1.5 seconds. This deliberately adds about 0.5 seconds at the speech boundary; it does not change Memory, TTS, playback, the 12-second wake/idle timeout or the avatar. Longer pauses may still end a turn. Official reference: https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies .

User proposes releasing personal Web ver1 after this fix. Final hesitation acceptance received Oct 7: 大丈夫そうだね. Do not infer separate results for every M3 item. Current body sway is deferred as a known limitation. Vendor reply received Oct 6 09:59 JST (message 1a10eb91f6a0e85f): vendor reports a quality bug, offers free regeneration and refund of original generation credits; newer model generation takes 10–20 seconds. No direct emotion/gesture controls. Current avatar preservation/overwrite behavior and precise sway/smile outcome remain unanswered. No regeneration or overwrite performed.

## ver1.0.0 personal release — 2026-10-07 JST

Release decision: user proposed shipping after the hesitation fix on Oct 6 and accepted the result Oct 7. Freeze the functional baseline at PR #46 merge 2f9aebebaa3f5373714fc8cb7a47f9b000c8876b; this release change updates only UI version/cache URL and documentation. Current appearance remains usable with body sway deferred to vendor follow-up. No avatar replacement or paid operation.

Acceptance is based on user device reports, not fabricated test measurements. The earlier exhaustive M3 checklist and account cost review are not fully evidenced: two timed five-minute runs, individual stop/restart/text/recall checks, the <=15s startup target and account-specific total costs remain verification debt. This personal release decision supersedes treating that entire checklist as a blocking gate; do not claim those items passed or that the budget was explicitly accepted. Existing bounded sessions and published usage caveats continue. Before broader distribution or increasing session limits, resolve access and budget review.

Next: follow up on preserving the current avatar during free vendor regeneration; then scope resident presence separately. Multi-party conversation and VR remain later milestones.
