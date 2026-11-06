# Distributed Wagering Processor

Processes casino bet transactions (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) from several game providers and
stays financially correct under duplicated, out-of-order and concurrent delivery, on any number of instances.

Stack: Bun · TypeScript (strict) · NestJS · MikroORM 7 · PostgreSQL 17 · AWS SQS (MiniStack locally) · Docker Compose.

Design decisions, trade-offs and known limitations: **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Quick start

### Everything in containers (only Docker needed)

```bash
docker compose up --build        # PostgreSQL + MiniStack, then migrations, then the app
```

Compose builds the image, starts PostgreSQL and MiniStack, runs the migrations in a one-shot `migrate` service and
starts `app` only after it succeeded and both dependencies are healthy. The API is on `http://localhost:3000`
(`/health/ready` is the container healthcheck). `docker compose stop app` is a graceful shutdown (in-flight SQS
messages and the outbox batch finish first; about 1 s). `docker compose down -v` removes everything.

### Try it in the browser: the test console

Open **http://localhost:3000** (it redirects to `/ui`). It is a small page served by the API itself, with no build step and
no dependencies, to drive the flows by hand and watch what happens:

* create a wallet, submit `BET` / `WIN` / `LOSS` / `REFUND` / `ROLLBACK`, **replay** the last request, or replay it with another
  amount to see the idempotency conflict; the wallet balance and its **ledger** update after every call;
* **six one-click scenarios**, each on its own wallet and verified against the ledger: ten identical bets at once (booked
  once), twenty bets fighting for 10.00 (exactly ten accepted), a reversal arriving before its bet (parked, then applied by the
  background worker), a second reversal refused, a spent win that cannot be rolled back, and the same id with another amount;
* **live metrics** (processed, rejected, duplicates absorbed, lock conflicts, outbox lag) and a **request log** with the full
  request and response of every call and its correlation id;
* a field for a bearer token when authentication is on (kept in memory only).

It is a development tool: `UI_ENABLED=false` turns it off (`/` and `/ui` then answer 404). It only makes same-origin requests,
renders every API value as text (never as HTML) and is served with a strict content security policy (no inline script, no
external origin); tests guard all three.

### Local development (Bun on the host, infra in containers)

Requirements: [Bun](https://bun.sh) 1.4+, Docker (with Compose).

```bash
bun install
cp .env.example .env
bun run infra:up          # PostgreSQL + MiniStack only, waits until healthy
bun run migration:up      # create the schema
bun run start             # API + SQS consumer + outbox publisher + pending-reference worker
```

The API listens on `http://localhost:3000`. Queues are created on startup. **Do not run the `app` container and the
integration tests at the same time**: a second consumer, outbox publisher and retry worker would race the tests for
their rows and queues. The test helpers detect an instance on port 3000 and stop with an explanation.

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"p1","currency":"BRL","openingCredit":"100.00"}'

curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -d '{"providerId":"acme","externalTransactionId":"bet-1","kind":"BET","playerId":"p1","currency":"BRL","amount":"10.00","roundId":"r1"}'
```

## Commands

| Command | What it does |
|---|---|
| `bun run infra:up` / `infra:down` | Start / stop (and wipe) PostgreSQL and MiniStack only |
| `bun run stack:up` / `stack:down` | Build and start / stop (and wipe) the whole stack including the app container |
| `bun run migration:up` / `migration:down` | Apply / revert the last migration (migrations are reversible) |
| `bun run migration:create [name]` | Generate a migration from the entity changes; **add its `down()`** (a test enforces it) |
| `bun run migration:check` | Fail if the entities and the migrated database differ (schema drift); runs in CI |
| `bun run start` / `dev` | Run the service / run with reload |
| `bun run typecheck` | `tsc --noEmit` in strict mode |
| `bun run test:unit` | Domain unit tests, no I/O |
| `bun run test:integration` | Integration + concurrency tests against real PostgreSQL and SQS (needs `infra:up`) |
| `bun run test:concurrency` | Only the concurrency / multi-instance / crash-recovery subset |
| `bun run test:load` | Load test; writes `load-test-report.json` (see below) |
| `bun run ci` | typecheck + unit + integration, as the CI does |

Run several instances against one database to see the multi-instance behaviour: `PORT=3001 bun run start` in
another terminal. Every test that matters runs with 2–3 instances in-process as well.

## API

All money is a decimal string with two places (`"10.00"`); JSON numbers are rejected.

| Method & path | Notes |
|---|---|
| `POST /wallets` | `{playerId, currency, openingCredit?}`. One wallet per player and currency (409 otherwise). The opening credit is booked in the same transaction. |
| `GET /wallets/:walletId` | Balance, `version`, `flaggedAt`. |
| `GET /wallets/:walletId/ledger?limit=&cursor=` | Opaque, stable cursor (ledger is append-only). |
| `POST /wallets/:walletId/reconciliation` | Compares stored vs ledger-derived balance. Reports, logs, counts and flags divergences; never corrects them. |
| `POST /wagering/transactions` | Header `Idempotency-Key` (default `{providerId}:{externalTransactionId}`). Body: `providerId, externalTransactionId, kind, playerId, currency, amount, roundId?, referenceExternalId?` (required for `REFUND`/`ROLLBACK`). |
| `GET /wagering/transactions/:transactionId` | |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | |
| `GET /health/live`, `GET /health/ready` | Liveness / readiness (PostgreSQL and SQS reachable). |
| `GET /metrics` | Prometheus text format. |

### Status codes

Consistent across the API:

| Code | Meaning |
|---|---|
| `201` | Processed now |
| `200` | Idempotent replay of a processed transaction (`idempotentReplay: true`) |
| `202` | Accepted, waiting for its reference (`PENDING_REFERENCE`) |
| `422` | Business rejection (`failureCode`, e.g. `INSUFFICIENT_FUNDS`, `REVERSAL_WOULD_OVERDRAW`, `ALREADY_REVERSED`, `REFERENCE_MISMATCH`) |
| `400` | Invalid payload |
| `404` | Unknown wallet / transaction |
| `409` | Idempotency conflict (same key or external id, different payload) or duplicate wallet |
| `503` | Transient infrastructure failure (`Retry-After: 1`); safe to retry with the same key |

Errors look like `{"error": {"code": "...", "message": "..."}}`.

## SQS

`wager-transactions.fifo` takes the same JSON body as the HTTP endpoint. Use the player (wallet) as `MessageGroupId`
to keep per-wallet order; correctness does not depend on it. Optional message attribute `correlationId` is propagated
to the logs. Poison messages and exhausted retries land in `wager-transactions-dlq.fifo` with a `FailureReason`
attribute. Domain events are published to `wager-events.fifo` (see ARCHITECTURE.md).

## Configuration

See [.env.example](.env.example) for the basics. Tuning knobs, all optional:

| Variable | Default | |
|---|---|---|
| `SQS_CONSUMER_ENABLED` | `true` | Run the queue consumer in this process |
| `SQS_CONSUMER_CONCURRENCY` | `4` | Parallel long-poll loops |
| `SQS_MAX_RECEIVE_COUNT` | `5` | Deliveries before a failing message goes to the DLQ |
| `SQS_RETRY_BASE_SECONDS` / `SQS_RETRY_MAX_SECONDS` | `2` / `300` | Exponential redelivery backoff |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `30` | Must be identical on every instance (queue attribute) |
| `OUTBOX_ENABLED` / `OUTBOX_PUBLISHERS` | `true` / `2` | Outbox publisher loops per instance |
| `PENDING_WORKER_ENABLED` | `true` | Retry worker for reversals that arrived before their reference |
| `PENDING_MAX_RETRIES` / `PENDING_BASE_DELAY_MS` / `PENDING_MAX_DELAY_MS` | `8` / `1000` / `300000` | Backoff before `REFERENCE_NOT_FOUND` |
| `LOCK_CONFLICT_THRESHOLD_MS` | `25` | Wallet lock wait counted as a conflict |
| `LOG_LEVEL` | `log` | `verbose`, `debug`, `log`, `warn`, `error` |
| `UI_ENABLED` | `true` | Serve the browser test console at `/ui` (and redirect `/` to it) |

## Tests

Integration tests use the real PostgreSQL and MiniStack from `docker-compose.yml`; nothing is mocked. They create
unique players per test, so they can run repeatedly against the same database. The invariant checked at the end of
every scenario is **stored balance == balance rebuilt from the ledger**.

Highlights: 50 identical parallel bets debit once; 50 parallel bets on a 30.00 wallet process exactly 30; three
instances on one queue; a worker killed after commit and before ack; two outbox publishers; a publisher killed after
sending and before commit; reversal before reference; graceful shutdown mid-stream; restart with a backlog.

## Load test

```bash
bun run test:load                                   # defaults: 15s, 64 concurrent, 50 wallets, 2 instances
LOAD_DURATION_SECONDS=60 LOAD_CONCURRENCY=128 bun run test:load
```

It boots the instances in-process, drives real HTTP traffic (60% BET, 25% WIN, 10% LOSS, 5% exact replays, 20% of the
traffic aimed at two hot wallets), waits for the outbox to drain, reconciles every wallet and fails if any money is
wrong. The report (also in `load-test-report.json`) lists environment, methodology, throughput, p50/p95/p99, error
rate, wallet lock conflicts and outbox lag. In GitHub Actions it is the manual **Load test** workflow.

Reference runs on a developer machine (Ryzen 7 5700X, 16 threads, PostgreSQL 17 in Docker on Windows, Bun 1.4.4,
2 instances, 10 s, concurrency 64, fresh database each run): **~310–470 req/s, p50 135–195 ms, p95 260–380 ms,
p99 400–540 ms, 0 % errors**, 0 diverging wallets, outbox drained in seconds. Run-to-run variance on this setup is
large (the same code varied by about 50% between runs). The load generator, both instances and the databases share the
machine, so read it as relative, not as capacity. The A/B history (raw SQL vs ORM vs optimized ORM) is in
ARCHITECTURE.md (limitations).

## License

All rights reserved. The code is public so it can be read and evaluated; no permission to use, copy, modify or
distribute it is granted. See [LICENSE](LICENSE).

## Authentication

Off by default (`AUTH_MODE=none`), so the API can be tried without an identity provider. With `AUTH_MODE=jwt` the API
validates bearer tokens issued by an external OpenID Connect provider (Keycloak, Zitadel, ...) and enforces **roles**
(`wager:submit`, `wager:read`, `wallet:read`, `wallet:write`, `wallet:reconcile`, `admin`) and **provider scoping** (a
token with a `provider_id` claim can only act for that provider). Health probes and `/metrics` stay public. Details and
the security checks: ARCHITECTURE.md, section 10.

| Variable | Default | |
|---|---|---|
| `AUTH_MODE` | `none` | `none` or `jwt` |
| `AUTH_ISSUER` | | Expected `iss`, e.g. `https://keycloak.example.com/realms/wagering` (required for `jwt`; https only) |
| `AUTH_AUDIENCE` | | Expected `aud` / this API's client id (required for `jwt`) |
| `AUTH_JWKS_URI` | discovered | Explicit JWKS URL; otherwise `<issuer>/.well-known/openid-configuration` |
| `AUTH_PROVIDER_CLAIM` | `provider_id` | Claim that scopes a token to one provider |
| `AUTH_ROLES_CLAIM` | | Extra claim (dot path) to read roles from, besides the Keycloak / Zitadel locations |
| `AUTH_CLIENT_ID` | audience | Client whose Keycloak client roles count |
| `AUTH_ALGORITHMS` | `RS256,PS256,ES256,EdDSA` | Asymmetric algorithms only |
| `AUTH_CLOCK_TOLERANCE_SECONDS` / `AUTH_JWKS_COOLDOWN_MS` / `AUTH_JWKS_TIMEOUT_MS` | `5` / `30000` / `3000` | |
| `AUTH_ALLOW_INSECURE_ISSUER` | `false` | Allow an `http://` issuer / JWKS URL (local development only) |

### Try it with a real Keycloak

```bash
docker compose -f docker-compose.yml -f docker-compose.auth.yml up -d --build --wait
bash docker/keycloak/smoke.sh        # tokens, roles, provider scoping, tampering, public probes

# by hand: a token for game provider "acme" (client-credentials grant), then a request with it
TOKEN=$(curl -s -d grant_type=client_credentials -d client_id=provider-acme -d client_secret=acme-dev-secret \
  http://localhost:8081/realms/wagering/protocol/openid-connect/token | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
curl -s -H "authorization: Bearer $TOKEN" localhost:3000/providers/acme/wagering/transactions/bet-1
```

The demo realm (`docker/keycloak/wagering-realm.json`) has clients `provider-acme`, `provider-globex` (roles
`wager:submit`, `wager:read`, scoped to their provider) and `ops-admin` (`admin`). Its secrets are public sample values:
**development only**. `docker compose -f docker-compose.yml -f docker-compose.auth.yml down -v` removes it.
