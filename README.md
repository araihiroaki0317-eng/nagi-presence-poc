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
