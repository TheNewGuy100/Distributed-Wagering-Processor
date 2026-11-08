# Distributed Wagering Processor

Processes casino bet transactions (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) from several game providers and
stays financially correct under duplicated, out-of-order and concurrent delivery, on any number of instances.

Stack: Bun · TypeScript (strict) · NestJS · MikroORM 7 · PostgreSQL 17 · AWS SQS (MiniStack locally) · Docker Compose.

Design decisions, trade-offs and known limitations: **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Quick start

### Everything in containers (only Docker needed)

```bash
docker compose up --build        # the whole system, one command (about a minute the first time)
```

Eight services come up, in dependency order, each with a healthcheck (`up --wait` returns when all are healthy):

| What | URL | Notes |
|---|---|---|
| **API + test console** | http://localhost:3000 (`/ui`) | PostgreSQL, MiniStack (SQS) and a one-shot `migrate` come first; `app` starts only after the migrations succeeded |
| **Events consumer** | http://localhost:3100 | A stand-in downstream system: reads the events the outbox publishes, drops repeated event ids, checks per-wallet order |
| **Grafana** | http://localhost:3001 | Opens straight on the provisioned dashboard "Wagering Processor" (no login to look; `admin`/`admin` to edit) |
| **Prometheus** | http://localhost:9090 | Scrapes the API's `/metrics` every 5 s |
| **Keycloak** | http://localhost:8081 | Identity provider with a demo realm (`admin`/`admin` for its console) |
| PostgreSQL / MiniStack | `localhost:5432` / `localhost:4566` | |

Authentication is **off by default**, so the API and the console work without a token. Keycloak is already running; turn the
authentication on for the same stack with one variable (the `app` container is recreated, nothing else):

```bash
AUTH_MODE=jwt docker compose up -d app
bash docker/keycloak/smoke.sh        # real tokens from Keycloak: roles, provider scoping, tampering
docker compose up -d app             # and back to no authentication
```

Handy: `docker compose stop app` is a graceful shutdown (in-flight SQS messages and the outbox batch finish first; about
1 s), `docker compose up -d --build app` rebuilds just the API, `docker compose down -v` removes everything.
Only the infrastructure (what the tests and `bun run start` use): `bun run infra:up`. Memory: the full stack wants a few GB
(Keycloak and Grafana are the heavy ones).

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
  -d '{"playerId":"p1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
# → {"id":"<walletId>","playerId":"p1","balance":{"amount":"100.00","currency":"BRL"},"version":1,...}

curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: acme:bet-1' \
  -d '{"providerId":"acme","externalTransactionId":"bet-1","playerId":"p1","walletId":"<walletId>","roundId":"r1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"10.00","currency":"BRL"}}'
```

> **Upgrading from an earlier checkout:** the initial migration was edited in place (new `game_id`, `balance_after`,
> `balance_before` columns) because nothing was deployed. Recreate an existing local database with
> `docker compose down -v`.

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
| `POST /wallets` | `{playerId, initialBalance: {amount, currency}}`. Answers `{id, playerId, balance: {amount, currency}, version, ...}`. One wallet per player and currency (409 otherwise). A non-zero initial balance is booked as an `OPENING` transaction with a ledger `CREDIT` in the same SQL transaction. |
| `GET /wallets/:walletId` | Balance, `version`, `flaggedAt`. |
| `GET /wallets/:walletId/ledger?limit=&cursor=` | Opaque, stable cursor (ledger is append-only). |
| `POST /wallets/:walletId/reconciliation` | Compares stored vs ledger-derived balance. Reports, logs, counts and flags divergences; never corrects them. |
| `POST /wagering/transactions` | **Mandatory** header `Idempotency-Key` (recommended `{providerId}:{externalTransactionId}`; 400 without it). Body: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money: {amount, currency}`, plus `referenceExternalTransactionId` for `REFUND`/`ROLLBACK`. `gameId` is required for `BET`/`WIN`/`LOSS` and stored on the transaction, so per-game reports need no extra registry. Answers `{transactionId, status, balance: {amount, currency}, idempotentReplay, ...}`; a replay returns the balance observed when the transaction was first settled. |
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

`wager-transactions.fifo` takes the envelope `{messageId, type: "WagerTransactionRequested", occurredAt, data}` where `data`
is the HTTP body plus `idempotencyKey` (the header's counterpart, mandatory). The business `messageId` is the inbox key.
Use the player (wallet) as `MessageGroupId`
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
| `OUTBOX_ENABLED` / `OUTBOX_PUBLISHERS` | `true` / `2` | Outbox publisher loops per instance (the publisher has its own DB pool, one connection per loop) |
| `DB_POOL_MAX` | `10` | Connections of the request pool per instance |
| `OUTBOX_RETRY_BASE_MS` / `OUTBOX_RETRY_MAX_MS` / `OUTBOX_MAX_ATTEMPTS` | `1000` / `60000` / `20` | Backoff for an event the broker refuses, and how many refusals make it `DEAD` |
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
sending and before commit; reversal before reference; graceful shutdown mid-stream; restart with a backlog; a reversal fired together with its own
reference; one external id with 20 different payloads or 20 keys; a seeded random concurrent workload whose balances are
recomputed from the stored statuses. The business rules are also checked as properties over 300 seeded random sequences
(`src/domain/settlement.property.test.ts`).

## Load test

```bash
bun run test:load                                   # defaults: 15s, 64 concurrent, 50 wallets, 2 instances
LOAD_DURATION_SECONDS=60 LOAD_CONCURRENCY=128 bun run test:load
```

It starts each instance as its own OS process (`LOAD_MODE=inprocess` boots them inside the load generator instead), drives real HTTP traffic (60% BET, 25% WIN, 10% LOSS, 5% exact replays, 20% of the
traffic aimed at two hot wallets), waits for the outbox to drain, reconciles every wallet and fails if any money is
wrong. The report (also in `load-test-report.json`) lists environment, methodology, throughput, p50/p95/p99, error
rate, wallet lock conflicts and outbox lag. In GitHub Actions it is the manual **Load test** workflow.

Reference runs on a developer machine (Ryzen 7 5700X, 16 threads, PostgreSQL 17 in Docker on Windows, Bun 1.4.4,
2 instances, 10 s, concurrency 64, fresh database each run): **~310–470 req/s, p50 135–195 ms, p95 260–380 ms,
p99 400–540 ms, 0 % errors**, 0 diverging wallets, outbox drained in seconds. Run-to-run variance on this setup is
large (the same code varied by about 50% between runs). The load generator, both instances and the databases share the
machine, so read it as relative, not as capacity. The A/B history (raw SQL vs ORM vs optimized ORM) is in
ARCHITECTURE.md (limitations).

Reference run on GitHub Actions (`ubuntu-latest`, 4 vCPU AMD EPYC, 17 GB, PostgreSQL 17, Bun 1.4.4, 2 instances,
30 s, concurrency 64, 50 wallets, [run 42486091984](https://github.com/TheNewGuy100/Distributed-Wagering-Processor/actions/runs/42486091984)):
**323 req/s, p50 193 ms, p99 643 ms, 0 % errors**, 0 diverging wallets, outbox **max lag 5.0 s, 7.9 s to drain** 17,511
events (a second run: 292 req/s, lag 6.5 s, drain 9.2 s). Same shared-machine caveat as above: the load generator, both
instances and the databases share 4 vCPUs, and both instances run in the load generator's own process.

How the outbox lag got there (same workload, same runner type): 14 s peak / 28.5 s drain at first; 18.6–20.1 s / 21.8–27.8 s
after the publisher sent a wallet's events in one batch (that helped the drain, not the peak); **5.0–6.5 s / 7.9–9.2 s** after
two fixes. (1) The follower lookup loaded *every* pending event of the wallets the publisher held and then kept 10, so a
cycle got slower as a hot wallet's backlog grew (now bounded; `scripts/bench-outbox.ts`: 251 to 560 events/s with one
loop, 398 to 765 with two). (2) The publisher shared the request connection pool and queued behind requests that were
waiting on a wallet lock, so almost nothing was published until the traffic stopped (now it has its own pool). The price is
a few percent of request throughput and latency (about 10 % lower req/s, p50 +20–40 ms), because the publisher now works
while the requests do.

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
AUTH_MODE=jwt docker compose up -d --build --wait     # the whole stack (Keycloak included) with authentication on
bash docker/keycloak/smoke.sh        # tokens, roles, provider scoping, tampering, public probes

# by hand: a token for game provider "acme" (client-credentials grant), then a request with it
TOKEN=$(curl -s -d grant_type=client_credentials -d client_id=provider-acme -d client_secret=acme-dev-secret \
  http://localhost:8081/realms/wagering/protocol/openid-connect/token | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
curl -s -H "authorization: Bearer $TOKEN" localhost:3000/providers/acme/wagering/transactions/bet-1
```

The demo realm (`docker/keycloak/wagering-realm.json`) has clients `provider-acme`, `provider-globex` (roles
`wager:submit`, `wager:read`, scoped to their provider) and `ops-admin` (`admin`). Its secrets are public sample values:
**development only**. In the browser console, paste a token into the "Bearer token" field to use the API with authentication on.
