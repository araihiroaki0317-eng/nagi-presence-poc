# Direct Voice PoC — Agent bypass

Status: design-only; no production path changed.

## Goal

Evaluate the smallest change that removes ElevenLabs Agent/Agent LLM from Nagi's live voice path while preserving the existing Conversation SoT and current Nagi voice.

## Existing assets to reuse

- Conversation SoT: Nagi Memory `/respond`
- Existing browser transcript UI and session/checkpoint handling
- Existing server-side Nagi TTS endpoint: `nagi-voice-transport /tts`
- Existing ElevenLabs secret binding in the voice transport Worker
- Existing Nagi voice identity resolved from the current ElevenLabs Agent configuration

## Target path

```
iPad microphone
  -> realtime STT
  -> final user transcript
  -> Nagi Memory /respond
  -> exact response text
  -> existing /tts
  -> browser audio + transcript
```

ElevenLabs Agent must not generate the assistant response in this path.

## Minimal implementation boundary

Add a voice-input adapter beside the existing typed Memory path. A final STT transcript should call the same Memory request function used by typed input. The returned Memory response remains the single source of truth and is sent unchanged to the existing TTS output.

Do not modify `main`. Do not replace Memory. Do not create a new orchestration service. Do not store provider secrets in the browser.

## Acceptance criteria

1. Start voice mode on iPad Safari without starting an ElevenLabs Conversational Agent session.
2. User speech produces a Japanese transcript in the existing conversation transcript.
3. Final transcript is sent once to the existing Memory `/respond` path.
4. Memory response text appears in the transcript and the exact same text is sent to Nagi TTS.
5. Existing Nagi voice is preserved.
6. End/interrupt does not duplicate Memory turns or TTS playback.
7. Failure of STT or TTS leaves text conversation usable.
8. Provider usage shows no Agent LLM usage for this path.
9. Measure first-response latency and compare with the current Agent path.
10. No change to `main` until live-device acceptance.

## Decision gate

After one short live-device A/B test, decide using only:
- Japanese naturalness
- conversational latency
- observed running cost

OpenAI voice remains a comparison fallback, not a new dependency for this PoC.
