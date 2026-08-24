# Nagi Memory Adapter — Milestone 3B

Small server-side boundary between Nagi Presence and the runtime memory engine.

## Why this exists

The Nagi Presence client is public GitHub Pages JavaScript. Memory-engine API keys must never be embedded in browser code or committed to GitHub. This Worker keeps the secret server-side and exposes only the minimal routes needed by the PoC.

## Current PoC stack

- Frontend: GitHub Pages (`nagi-presence-poc`)
- Adapter: Cloudflare Workers
- Runtime memory candidate #1: Mem0 Platform
- Canonical human-readable record: Notion

## Routes

- `GET /health`
- `POST /memory/add`
- `POST /memory/search`
- `POST /memory/list`

The adapter proxies Mem0 Platform V3 endpoints and keeps `MEM0_API_KEY` in the Worker environment.

## Required secret

`MEM0_API_KEY`

Do not commit the key. Add it using Cloudflare's encrypted Worker secret settings after deployment.

## Intended evaluation

Use the existing Nagi Memory Policy baseline cases to test:

1. Direct recall
2. Contextual recall
3. Irrelevant-memory suppression
4. Temporal/current-vs-old behavior
5. Correction/supersession behavior

Mem0 is the first PoC because the hosted Hobby plan is free and small enough for this experiment. Zep remains the comparison candidate for temporal/graph behavior.

## Safety boundary

This folder does not alter the stable Presence Client v1.0.1. Milestone 3B is isolated until the adapter and memory retrieval tests pass.
