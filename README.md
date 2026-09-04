# nagi-presence-poc

凪プロジェクト Phase 1 / Gate 1 Presence UI PoC。

## Purpose

静止写真の状態遷移だけで「聞く → 考える → 返す」というPresenceが成立するかをiPad / iPhone Safariで検証する。

## Visual states

- Neutral
- Listening
- Thinking
- Warm

## Required assets

`assets/` フォルダに以下の4ファイルを配置する。

- `neutral.jpg`
- `listening.jpg`
- `thinking.jpg`
- `warm.jpg`

## Gate 1 PASS condition

コードが動くことではなく、実機上で写真の切替ではなく同じ凪さんが会話状態に応じて反応しているように感じられること。

## Phase 2D runtime foundation

`runtime/` contains the first implementation slice of the Mode / Role handoff:

- minimal runtime state with provenance-checked overrides and project state
- deterministic turn/session override expiry
- append-only event semantics with sequence numbers and idempotency keys
- browser-local event persistence behind a replaceable store boundary
- lightweight structured checkpoints after completed turns and manual stops
- in-page event inspection and JSONL export for human verification

The current PoC intentionally keeps events in browser storage. Durable server-side
storage and analysis are a later slice and require an explicit Cloudflare storage
binding. No inferred Role / Mode is persisted as state.

Run the unit tests with `npm test`.

## Browser support policy

- Reference runtime: Chrome across desktop, Android, iPadOS, and iOS
- Primary compatibility target: Safari on iPadOS and iOS
- Core implementation: standards-based Web APIs; no required Chrome extension
- Optional future AI integrations: adapters such as APIs or MCP, not hard
  dependencies of the Presence client

Chrome-specific extensions or built-in AI APIs may be evaluated later, but the
core conversation and Presence experience must remain usable without them.

## Milestone 3C: voice + chat

The Presence client now treats voice and text as channels of one conversation,
not as separate personas or memory streams.

- Voice input with voice + text responses
- Text input with text-only responses by default
- Optional text input with voice + text responses
- One expandable transcript shared by every channel
- Channel provenance in the JSONL event log
- Conversation checkpoints preserved when switching channels
- Gentle phrase-by-phrase reveal for short agent replies; tap to reveal instantly
- Reduced-motion and long-response fallbacks

Open the client with `?mock=1` to exercise connection, message, motion,
transcript, resume, and logging behavior without starting an ElevenLabs session.

For live text-only conversations, the ElevenLabs agent must allow the
conversation `textOnly` runtime override and emit agent response events. Keep
the agent itself voice-capable; the client selects text-only behavior per
session.

## Conversation Core separation (Slice 0)

The mock path now runs through a provider-neutral `ConversationCore`.

- `runtime/conversation-core.js` owns the logical conversation lifecycle.
- `runtime/channel-route.js` models input and output channels independently.
- `providers/mock-provider.js` implements the first common provider contract.
- Provider disconnect pauses rather than closes the logical conversation.
- Mock lifecycle events are written to the existing JSONL event stream.

The live ElevenLabs route remains a legacy adapter in this slice. No provider
credentials or external API calls are required by the new core tests.

## Legacy provider isolation (Slice 1)

ElevenLabs-specific session behavior now lives in
`providers/legacy-elevenlabs-adapter.js`. The Presence application constructs a
lazy adapter at startup and fetches the external SDK only when a live session is
actually requested. A missing SDK can therefore fail a connection attempt
without preventing the page, stored transcript, diagnostics, or mock route from
initializing.

## Independent text gateway foundation (Slice 2A)

`providers/http-text-provider.js` and `gateway/text-protocol.js` define the
independent text route without selecting or contacting a real model provider.
Tests inject a fake Gateway and cover identity propagation, normalized errors,
usage events, interruption, and HTTPS enforcement. The browser request contains
no provider credential.

The server contract and unresolved security decisions are documented in
`conversation-gateway/README.md`. No Gateway host, production URL, provider,
model, API key, or budget value has been configured.
