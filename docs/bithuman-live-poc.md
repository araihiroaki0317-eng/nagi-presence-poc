# bitHuman live conversation PoC

The fixed Sofia × Nagi WAV render passed on 2026-10-02 JST (job
`vid_34231ebf78ca49508e93`, 4 credits). Hiro accepted its voice/lip-sync quality.
This establishes short rendered-video quality, not live conversational latency.
LiveKit authentication was explicitly approved as an exception to the previous
no-new-credential-path constraint.

## Existing resources

`bithuman-live.html` uses the existing `nagi-voice-transport` Worker and
`nagi-memory-adapter`. There is no new Worker, Python service, or LiveKit Agent
deployment. Two browser LiveKit participants occupy one room: a standard viewer
and an agent-kind PCM sender. bitHuman is the third participant and publishes the
synchronized audio/video tracks.

Voice input uses the existing ElevenLabs Scribe route. Memory/LLM replies use the
existing conversation adapter and `hiro` / `nagi-poc-002`, matching the existing
Speech Engine transport. Only the reply text goes to the existing `/tts` route.
Its `pcm_16000` response is sent over `lk.audio_stream` to the bitHuman avatar.
The browser does not play TTS separately.

## Required configuration

Add these **Production Secrets** to the existing Cloudflare Worker
`nagi-voice-transport` (using Secrets for all three avoids dashboard variables
being replaced by the current Wrangler `[vars]` on subsequent deployments):

| Name | Value from the same LiveKit Cloud project |
| --- | --- |
| `LIVEKIT_URL` | Project URL, `wss://…livekit.cloud` |
| `LIVEKIT_API_KEY` | Project API key |
| `LIVEKIT_API_SECRET` | Project API secret |

Retain existing `BITHUMAN_API_SECRET`, `ELEVENLABS_API_KEY`, and
`NAGI_RESPOND_ENDPOINT`. No secret is entered in browser HTML or committed.
`BITHUMAN_AGENT_CODE` is optional; it defaults to Sofia `A52DHS2219`.
The real Nagi identity still requires a separately approved custom-avatar step.

## Validation and operation

- `GET /bithuman-live/health`: names of missing settings only; no session starts.
- `GET /bithuman-live/verify`: read-only LiveKit `ListRooms` auth check; room names
  and participant data are not returned.
- `POST /bithuman-live/prepare`: create a random, three-participant room and
  five-minute, room-scoped client tokens. No bitHuman render starts here.
- `POST /bithuman-live/start`: launch Essence 2 after both clients have joined.
- `POST /bithuman-live/stop`: request bitHuman session end and delete the room.
  A signed, thirty-minute control capability limits start/stop to this PoC room.

All requests use Origin `https://araihiroaki0317-eng.github.io`. Like the existing
PoC endpoints, these are a restricted-origin prototype, not user-authenticated
multi-user production endpoints.

The UI ends after 90 seconds, on leaving the page, on connection loss, or on
explicit Stop. The 90-second timer is browser-side, not a guaranteed server-side
billing cap. bitHuman also ends when the last standard user leaves. Failed stop
requests retain the signed control capability for retry on this device.
LiveKit empty/departure timeouts are 30/10 seconds. Automatic generation retries
are not performed.

After configuration, verify authentication and obtain approval for the next
credit-consuming live session. Test a typed turn first, then press 話す for a
spoken turn. Microphone capture stops during the reply to prevent feedback.
If iPad blocks autoplay, use 音声を再生. Subjective latency and lip sync require
iPad acceptance; mocked tests do not establish live compatibility.

## References

- https://docs.bithuman.ai/platforms/livekit/cloud-avatar
- https://docs.bithuman.ai/api/runtime-sessions
- https://docs.livekit.io/frontends/build/authentication/
- https://github.com/livekit/node-sdks/blob/main/packages/livekit-server-sdk/src/AccessToken.ts
- https://github.com/livekit/client-sdk-js/blob/main/src/room/participant/LocalParticipant.ts


## Continuous conversation follow-up

The start gesture requests microphone permission before creating a room. After
Nagi's greeting, speech recognition starts automatically and resumes after each
reply. The microphone control is now mute/resume. During playback the input
connection closes to prevent self-transcription; reconnect latency remains and
is measured, rather than described as eliminated. Barge-in is not supported.

The existing attention.js exact wake vocabulary is reused. Twelve seconds without
speech switches to wake-only idle. Idle transcripts other than a standalone wake
call are dropped before the Memory request. Idle still uses remote STT and its
usage allowance; this is not local wake-word detection or speaker identification.
Conversation mode can still accept unrelated nearby speech. The 90-second test
limit and page-leave cleanup remain.

Debug timings: microphone readiness; memory_response_ms (the whole /respond call,
including backend persistence); tts_first_pcm_ms; avatar_playback_started_ms
(provider notification, not proof of audible iPad playback). Existing Memory
learning waits were identified in source but have not been moved or timed on a
paid production turn. No extra billed trial is run by this change.


## Measured trial after PR 30

User screenshots: microphone ready 0.5–0.7s; Memory response 1.941–4.903s;
TTS first PCM 0.811–2.731s on normal replies; avatar start notification
1.306–3.239s after output.speak begins. Completed turns include playback duration.
The transcript includes a complaint about inaudible sound. Provider playback
notifications do not prove device audibility. Room deletion and provider end
acknowledgement both returned true.

Audio playback now uses a persistent audio element, requests LiveKit audio unlock
in the original start gesture, records subscribed track identities and device
play() outcomes, and retains the replay button on rejection. Both the avatar and
its approved publish-on-behalf sender identity are accepted. This is a mitigation
and better diagnosis; autoplay was not proven to be the reported failure cause.
Standalone nonverbal transcript markers such as (咳払い) are discarded without
an LLM request. This does not filter arbitrary noise recognized as normal words.
