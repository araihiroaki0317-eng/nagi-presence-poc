# Nagi Conversation Gateway Contract v0.1

This directory defines the future server-side boundary for an independent text
conversation provider. It is a contract only: no endpoint has been deployed and
no provider credential is configured.

## Endpoint

`POST /v1/text/respond`

Request:

```json
{
  "schema_version": "0.1",
  "conversation_id": "conv_001",
  "turn_id": "turn_001",
  "context": "approved context pack",
  "input": {
    "type": "text",
    "content": "続きを進めよう",
    "channel": "text"
  },
  "output_channels": ["text"]
}
```

Success:

```json
{
  "schema_version": "0.1",
  "turn_id": "turn_001",
  "output": { "text": "うん、続きから進めよう。" },
  "provider": { "id": "unselected", "model": "unselected" },
  "usage": {
    "status": "estimated_or_reported",
    "input_units": null,
    "output_units": null,
    "estimated_cost": null,
    "currency": null
  }
}
```

Failure:

```json
{
  "error": {
    "code": "provider_unavailable",
    "message": "Text provider is unavailable.",
    "retryable": true
  }
}
```

## Security gate before implementation

- The browser never receives a provider API key.
- The Gateway accepts requests only from the approved Presence origin.
- Provider and model are allow-listed server-side.
- Request size, rate, session budget, and monthly budget are capped.
- Raw prompts and responses are not added to infrastructure logs by default.
- Estimated usage and confirmed billing remain distinct.
- A provider change that can alter cost is not made silently.

## Explicitly not decided

- Gateway host and account
- Text model or provider
- Authentication method between Presence and Gateway
- Budget values
- Retention period
- Production URL

No credential should be issued until these items and the secret-storage path are
approved.

## Local Gateway Stub

`worker.js` implements the boundary locally with no external provider:

- exact Origin allow-list
- hashed bearer-token verification
- request-size limits
- mandatory budget-guard binding
- provider binding called only after budget authorization
- fail-closed behavior when authentication, budget guard, or provider is absent

The accompanying tests use a fake device credential and in-memory bindings.

`runtime/session-token-store.js` implements the approved PoC client policy: a
Gateway-only token may live in `sessionStorage` for at most eight hours, has no
automatic renewal, and is removed when expired. `providers/http-text-provider.js`
reads it at request time and fails before network use if it is absent. Pairing
and token issuance are implemented locally through `POST /v1/pairing/redeem`
and the `DeviceAuthLedger` Durable Object. The Presence pairing form and HTTP
text route remain dormant until the `nagi-gateway-url` meta value receives an
explicit deployment URL.

The pairing deployment requires three server-side values:

- `PAIRING_CODE_SHA256`: SHA-256 of the one-time code, stored as a secret
- `PAIRING_CODE_ISSUED_AT`: ISO timestamp for issuance
- `PAIRING_CODE_EXPIRES_AT`: ISO timestamp no more than ten minutes later

The code becomes unusable after one successful redemption or five failed
attempts. The ledger stores only code and token digests. A redeemed token lasts
eight hours, cannot refresh itself, and is checked before budget authorization
or Workers AI execution.

## Deployable evaluation Worker

`cloudflare-entry.js` composes the public Gateway, Workers AI provider, cost
estimator, SQLite-backed budget ledger, and device-auth ledger in one Worker.
`wrangler.jsonc` declares the AI and Durable Object bindings. Pairing code
material and timestamps remain server-side configuration and are intentionally
absent from source control. The static `DEVICE_TOKEN_SHA256` path remains only
as a local/test compatibility fallback when no device-auth binding is present.

The evaluation configuration is bounded to 12 total requests, one request per case conversation, 300 maximum output units, and USD 0.01 reserved cost. Deployment is not authorized by the provider-use envelope and remains a separate external change.

They do not create credentials, contact a provider, consume inference tokens, or
deploy a Worker.

## Local Budget Guard

`budget-guard.js` supplies an in-memory reference ledger for tests. Every Turn
must reserve capacity before the provider is called. Successful responses commit
the reservation; failed provider calls release it. Duplicate authorization and
commit operations are idempotent, and pending reservations count toward limits
so concurrent requests cannot bypass the cap in one runtime instance.

The current limits are abstract Turn and character caps, not prices or provider
token allowances. The in-memory implementation now also accepts conservative
cost estimates in integer micro-units. A trusted server-side estimator is
mandatory before authorization: without an estimate, the Gateway fails closed.

Soft cost limits return a warning that the Presence layer can translate into a
natural check-in. Hard cost limits reject the Turn before the Provider binding
is called. An approved spending envelope may continue without confirmation on
every Turn; only threshold, scope, provider, model, or limit changes require a
new decision.

The in-memory implementation is not a production persistence choice; an
external deployment still requires an atomic durable store and measured cost
limits.

`budget-store.js` separates atomic period transactions from the policy engine.
The local Store serializes simultaneous reservations and can be shared across a
replacement Guard instance. A production Store must preserve the same atomic
transaction and reservation lookup semantics; merely writing counters after
each request is insufficient because concurrent Turns could pass the same cap.

## Model and output lock

The trusted estimator returns the allowed Provider ID, Model ID, maximum output
units, and a conservative cost reservation. The Gateway passes that envelope to
the Provider binding and rejects a response from a different Provider or Model,
or one reporting output beyond the ceiling.

Once an upstream call has been attempted, an ambiguous network failure is not
treated as free. Its reservation remains held and automatic retry is disabled.
Provider errors release the reservation only when the trusted binding explicitly
reports that no usage was incurred. This biases accounting toward overstatement
rather than hidden spend.

## Route unlock and fallback

`runtime/route-access.js` ties a hard lock to the spending envelope that reached
its limit. Replaying the same envelope cannot unlock the route; only a new,
explicitly approved envelope for that exact route can do so.

`runtime/fallback-router.js` selects a different route automatically only when
it is actually available and supports the required channels. A route without
billing may be selected directly. A metered route additionally needs its own
approved envelope with automatic fallback explicitly enabled. Merely having a
second Provider configured is not permission to spend through it.
