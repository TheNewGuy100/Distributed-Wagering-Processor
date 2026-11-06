# Architecture

## 1. Goal and guarantees

The service books bets, wins, losses, refunds and rollbacks against player wallets. What it promises, on any number
of instances and under duplicated, reordered, concurrent and crashing delivery:

1. A wallet balance is never negative.
2. Every balance change has exactly one ledger entry, and `balance == sum(ledger)` always holds.
3. A business transaction is applied at most once, however many times it is delivered (HTTP retries, SQS redelivery,
   crashes after commit).
4. Events are published only for committed changes and are never lost (at-least-once, with stable ids to deduplicate).

These are enforced **in the database schema first** (constraints, triggers), and by application code second.

## 2. Shape of the system

```
 providers ──HTTP──▶ ┌────────────────────────────┐
                     │ ProcessWagerTransaction    │◀── SQS consumer (inbox)
 providers ──SQS───▶ │ (one SQL transaction)      │◀── PendingReferenceWorker
                     └──────────────┬─────────────┘
                                    │ same transaction
              wallets · wager_transactions · ledger_entries · inbox_messages · outbox_events
                                    │
                         OutboxPublisher (N loops × M instances, SKIP LOCKED)
                                    ▼
                          wager-events.fifo  (SQS)
```

Layers: `domain/` (pure TypeScript: `Money`, `Wallet`, rules, events, no framework), `application/` (use cases),
`infrastructure/` (SQL, SQS, outbox, metrics, logging), `interfaces/` (HTTP controllers, SQS consumer).
One NestJS process runs everything; each part can be switched off per instance (`SQS_CONSUMER_ENABLED`,
`OUTBOX_ENABLED`, `PENDING_WORKER_ENABLED`) so roles can be split later without code changes.

### Persistence: MikroORM, with explicit SQL on the hot path

MikroORM owns the connection pool, transactions (`em.transactional`) and the reversible migrations. The financial
core uses parameterised SQL through `em.execute` inside those transactions instead of mapped entities, because its
correctness is defined by `INSERT … ON CONFLICT DO NOTHING`, `SELECT … FOR UPDATE [SKIP LOCKED]` and `RETURNING`;
hiding those behind a unit of work would make the guarantees harder to read and to test. Trade-off: no entity
mapping or change tracking, and a little more SQL to maintain.

## 3. Data model and invariants

| Table | Role | Invariants enforced by the database |
|---|---|---|
| `wallets` | Aggregate root | `CHECK balance >= 0`; `UNIQUE (player_id, currency)`; `version` bigint |
| `wager_transactions` | One row per external transaction; also the idempotency record | `UNIQUE (provider_id, external_transaction_id)`; `UNIQUE (idempotency_key)`; status/kind `CHECK`s; reversals must carry a reference; **partial unique index: a processed transaction has at most one processed reversal** |
| `ledger_entries` | Append-only audit trail | `UNIQUE (wallet_id, transaction_id)` (one entry per wallet per transaction); `amount > 0`; `balance_after >= 0`; **`UPDATE`/`DELETE`/`TRUNCATE` trigger raises** |
| `inbox_messages` | Consumer-side dedup | `PRIMARY KEY (consumer, message_id)` |
| `outbox_events` | Transactional outbox | `seq` identity (publish order), partial indexes on unpublished rows |

Money is `NUMERIC(18,2)` in SQL and `bigint` minor units in code (`Money`): immutable, non-negative, strict
`"10.00"` parsing (no floats, signs or exponents), single-currency arithmetic enforced (mixing currencies throws).
Currency is a field of every amount, so multi-currency needs no model change (one wallet per player and currency).

`LOSS` and rejected transactions produce no ledger entry. `version` increments only when the balance changes, and
therefore equals the number of ledger entries; reconciliation checks that too.

### Reversals are stricter than the minimum

The brief allows one reversal per operation type. The service allows **one reversal per transaction, of any type**:
a `REFUND` followed by a `ROLLBACK` of the same bet would return the stake twice. This is enforced in the domain
(`ALREADY_REVERSED`) and by the partial unique index as the last line of defence. Only `BET` and `WIN` are reversible
(`LOSS` moved nothing; reversals and `OPENING` are final). Reversing a `WIN` that has already been spent is rejected as
`REVERSAL_WOULD_OVERDRAW`, distinct from `INSUFFICIENT_FUNDS`.

## 4. The transactional core

`ProcessWagerTransaction` runs one SQL transaction (shared by HTTP, SQS and the retry worker via `settleTransaction`):

1. **Lock the wallet row** (`SELECT … FOR UPDATE`, found by player and currency). This serialises every balance
   change of one wallet, with no global lock: other wallets proceed in parallel.
2. **Claim the idempotency key**: `INSERT … ON CONFLICT DO NOTHING`. A concurrent duplicate blocks on the unique
   index until the first commits, then sees the conflict.
3. Decide (pure `decide()`), append the ledger entry, update balance and `version` (guarded by `WHERE version = ?`,
   a second line of defence against lost updates), set the final status.
4. Write outbox events. Commit.

### Lock ordering lesson (found by the concurrency tests)

The first version inserted the transaction row (which has a foreign key to `wallets`) and *then* locked the wallet.
The FK insert takes `FOR KEY SHARE` on the wallet row; two transactions each holding it and asking for
`FOR UPDATE` wait on each other, and under 50 parallel requests the system stalled. The rule is now: **the wallet
lock is always the first statement touching the wallet**, in every code path (also the retry worker). This is
documented where the lock is taken (`lockWalletByPlayer`).

### Idempotency

Key = `Idempotency-Key` header, default `{providerId}:{externalTransactionId}`. The payload hash is SHA-256 of the
canonical JSON (sorted keys) of the business fields only (provider, external id, kind, player, currency, amount,
round, reference). Same key and hash returns the stored result with `idempotentReplay: true` (the status code reflects
the stored outcome); same key or external id with a different hash is `409 IDEMPOTENCY_CONFLICT`. All state is in
PostgreSQL: there is no in-memory idempotency anywhere, and a restart or another instance changes nothing.

## 5. Out-of-order reversals

A `REFUND`/`ROLLBACK` whose reference does not exist yet (or is not final) is stored as `PENDING_REFERENCE` with
`next_retry_at`, answered `202`, and announced with `WagerTransactionPendingReference`. `PendingReferenceWorker`
re-evaluates due rows with the same `settleTransaction` code: wallet lock first, then the row with `SKIP LOCKED`, so
any number of instances can run it. Backoff is exponential with a cap; after `PENDING_MAX_RETRIES` the transaction is
rejected with `REFERENCE_NOT_FOUND` (or `REFERENCE_NOT_PROCESSED` if the reference exists but never resolved). A late
reference that does not match (amount, round, player, provider, currency, wallet) is rejected, not applied.

## 6. SQS consumer

* Same JSON as the HTTP body. The handler runs **inbox insert + business transaction in one SQL transaction**, so a
  message is applied and recorded together or not at all. Ack (delete) happens only after commit.
* A duplicated *message* is absorbed by the inbox (`consumer, MessageId`); a duplicated *business transaction* sent
  as a different message is absorbed by idempotency. Two independent layers, neither relies on FIFO ordering.
* Classification: **business** errors (idempotency conflict, domain errors) → ack; **permanent** (unparseable,
  invalid) → explicit send to the DLQ, then ack; **transient** (database errors, wallet not found yet, anything
  unknown) → `ChangeMessageVisibility` with exponential backoff, and to the DLQ after `SQS_MAX_RECEIVE_COUNT`
  deliveries. Unknown errors are retried rather than dropped: silently losing a financial message is worse than a late
  DLQ entry. The queue's own redrive policy (`max + 2`) is only a safety net.
* Messages of one FIFO group are handled in order and different groups in parallel; if one fails, the rest of that
  group's batch is released untouched to preserve order.
* Shutdown: stop polling (abort the long poll), let in-flight messages finish (bounded by
  `SQS_SHUTDOWN_GRACE_MS`), release received-but-unstarted messages. Redelivery is harmless thanks to the inbox.
* Queue creation is idempotent but strict: `CreateQueue` fails if an existing queue has different attributes, so
  configuration drift between instances stops the deploy instead of passing unnoticed.

## 7. Outbox

Events (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`,
`WalletBalanceChanged`) are rows in `outbox_events`, inserted in the same transaction as the change; nothing is
published before commit, because only committed rows are visible to the publisher.

`OutboxPublisher` claims rows with `FOR UPDATE SKIP LOCKED`, sends a batch, marks `published_at` in the same
transaction and commits. If a publisher dies after sending but before committing, the row is still unpublished and
is sent again: **at-least-once**. The FIFO `MessageDeduplicationId` is the event id (5-minute broker window) and
consumers must deduplicate by `eventId` beyond that.

Order: `seq` is assigned at insert time, under the wallet lock, so it follows the real order of changes (a
timestamp would be the transaction *start* time and could invert). A row is only claimable if no earlier unpublished
row of the same aggregate exists, so concurrent publishers never overtake each other within a wallet; the SQS message
group is the aggregate id. `WalletBalanceChanged` also carries `walletVersion` so a consumer can reorder or detect gaps.

Events are an abstract `DomainEvent` envelope (`eventId`, `eventType`, `version`, `aggregateId`, `occurredAt`,
`data`) with typed subclasses; money is always a string. `WalletBalanceChanged` is emitted only when the balance
changes (never for `LOSS` or rejections).

## 8. Reconciliation

`POST /wallets/:id/reconciliation` computes, in a single SQL statement (one snapshot, so traffic cannot cause false
alarms), the ledger-derived balance and compares it with the stored balance, the `version`/entry count and the last
`balance_after`. A divergence is logged as an error, counted (`wallet_reconciliation_divergences_total`) and flagged
(`wallets.flagged_at`, first flag time preserved). **It is never corrected automatically**: which side is right is an
audit decision. Corruption can only affect `wallets.balance` or `version`, because the ledger is physically immutable.

## 9. Observability

* **Logs**: one JSON object per line. An `AsyncLocalStorage` context adds `correlationId` (from `x-correlation-id`
  or the SQS `correlationId` attribute), `messageId`, `transactionId`, `walletId`, `providerId` to every line. A key
  deny-list (`amount`, `balance`, `payload`, `body`, `authorization`, …) keeps financial payloads out of the logs.
* **Metrics** (`GET /metrics`, Prometheus text): transactions by kind/status/source, duplicates by layer, idempotency
  conflicts, failures by reason, retries, DLQ by reason class, wallet lock wait histogram and conflict counter,
  processing latency histogram, HTTP requests/latency, outbox published/failed, and scrape-time gauges for outbox
  lag and size, waiting reversals and flagged wallets.
* **Health**: `/health/live` touches nothing; `/health/ready` requires PostgreSQL and SQS.

## 10. Authentication (decision and extension point)

Authentication is not implemented, deliberately: the service must not own user tables, and the challenge does not
score it. The extension point is real, not a comment: a global `AuthGuard` calls an `Authenticator` port and attaches
a `Principal` (`subject`, optional `providerId`, `roles`) to the request; health and metrics are `@Public()`. The
default `NoopAuthenticator` lets everything through. A test replaces the authenticator and verifies 401s on protected
routes while probes stay open.

To enable it: add a `JwtAuthenticator` that validates the bearer token against the identity provider's JWKS
(Keycloak or Zitadel: signature, issuer, audience, expiry), maps claims to `Principal`, and bind it to `AUTHENTICATOR`.
Then reject requests whose `providerId` differs from `principal.providerId` (the check belongs next to
`parseWagerCommand`). SQS messages are a trusted internal channel, but provider identity in them still goes through
the same domain validation.

## 11. Testing strategy

Unit tests (`src/**/*.test.ts`) cover `Money`, `Wallet` invariants, every transaction rule, currency conflicts, the
status machine, backoff, payload hashing and idempotency conflicts, logger and metrics. Integration tests
(`test/integration`) run against real PostgreSQL and MiniStack (`docker compose`), never mocks, and include the
concurrency scenarios from the brief with real parallelism. MiniStack's SQS behaviour that the design depends on (FIFO
deduplication, redelivery after the visibility timeout, redrive to a DLQ) is pinned by a contract test, and the image
version is pinned.

## 12. Known limitations and trade-offs

* **Per-wallet throughput is bounded by the row lock.** Correctness over speed for one wallet; scaling comes from
  many wallets in parallel (load test: hot wallets show up as lock conflicts, not errors).
* **Outbox head-of-line blocking**: an event the broker permanently refuses blocks later events of the same aggregate.
  Alert on `outbox_lag_seconds` and `outbox_publish_failures_total`. A partially failed batch can send a later event
  of an aggregate before an earlier one; consumers can reorder with `walletVersion`.
* **Clock skew**: retry times are computed with the application clock and compared with the database clock. Instances
  with noticeably skewed clocks delay or advance retries (not correctness).
* **Metrics are per-process counters** (reset on restart); aggregate them in Prometheus. The conflict metric is a
  wait-time heuristic (≥ `LOCK_CONFLICT_THRESHOLD_MS`), not a PostgreSQL lock counter.
* **MiniStack is an emulator**: FIFO and DLQ semantics are verified by the contract test, but real AWS SQS (limits,
  throttling, the exact 5-minute deduplication window) was not exercised.
* **Reference lookup is scoped to the same provider** (a reversal can only reference its own provider's transaction).
* **No rate limiting or request size policy** beyond Nest defaults; no authentication until the extension point is used.
* **Transient errors on the HTTP path return `503` and persist nothing**, so the caller retries with the same key; a
  `WalletNotFound` is `404` and also persists nothing.
* The load test runs the instances, the generator and (locally) the databases on one machine; its numbers are
  relative, not capacity figures.
