import { defineEntity, p, type InferEntity } from '@mikro-orm/core';

/**
 * The schema is owned by these entities: migrations are generated from them (`migration:create`) and CI fails
 * when entities and migrated database drift apart (`migration:check`).
 *
 * Money is `numeric(18,2)` mapped to a string (never a JS number); relations use `mapToPk()` so a foreign key
 * is read and written as its plain id and no entity graph is ever hydrated on the hot path.
 *
 * Two guarantees live outside the entities because MikroORM cannot track them: the statement-level
 * `TRUNCATE` trigger on `ledger_entries` (see the `...ledger_truncate_guard` migration) — everything else,
 * including the row-level append-only trigger, is declared below.
 */

export const Wallet = defineEntity({
  name: 'Wallet',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.text().fieldName('player_id'),
    currency: p.string().columnType('char(3)'),
    balance: p.decimal('string').columnType('numeric(18,2)').default('0'),
    version: p.bigint('number').default(0),
    createdAt: p.datetime().fieldName('created_at').columnType('timestamptz').defaultRaw('now()'),
    /** Set by reconciliation when stored and recomputed balances diverge; never auto-cleared. */
    flaggedAt: p.datetime().fieldName('flagged_at').columnType('timestamptz').nullable(),
    flagReason: p.text().fieldName('flag_reason').nullable(),
  },
  uniques: [{ name: 'wallets_player_currency_unique', properties: ['playerId', 'currency'] }],
  checks: [{ name: 'wallets_balance_non_negative', expression: 'balance >= 0' }],
});

export const WagerTransaction = defineEntity({
  name: 'WagerTransaction',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.text().fieldName('provider_id'),
    externalTransactionId: p.text().fieldName('external_transaction_id'),
    idempotencyKey: p.text().fieldName('idempotency_key'),
    payloadHash: p.text().fieldName('payload_hash'),
    kind: p.text(),
    status: p.text(),
    playerId: p.text().fieldName('player_id'),
    currency: p.string().columnType('char(3)'),
    amount: p.decimal('string').columnType('numeric(18,2)'),
    roundId: p.text().fieldName('round_id').nullable(),
    /** Which game the round belongs to; there is no games registry, so this is the only handle for per-game reports. */
    gameId: p.text().fieldName('game_id').nullable(),
    /** Wallet balance observed when the transaction was settled; a replay returns exactly this value. */
    balanceAfter: p.decimal('string').fieldName('balance_after').columnType('numeric(18,2)').nullable(),
    wallet: () => p.manyToOne(Wallet).mapToPk().fieldName('wallet_id').nullable().deleteRule('no action'),
    referenceExternalId: p.text().fieldName('reference_external_id').nullable(),
    referenceTransaction: () =>
      // Self reference by name: the schema constant does not exist yet at this point, and referring to it would be a
      // circular type. `any` keeps the property (typed loosely: it is just the referenced id) in the inferred type.
      p.manyToOne('WagerTransaction' as any).mapToPk().fieldName('reference_transaction_id').nullable().deleteRule('no action'),
    failureCode: p.text().fieldName('failure_code').nullable(),
    retryCount: p.integer().fieldName('retry_count').default(0),
    nextRetryAt: p.datetime().fieldName('next_retry_at').columnType('timestamptz').nullable(),
    createdAt: p.datetime().fieldName('created_at').columnType('timestamptz').defaultRaw('now()'),
    updatedAt: p.datetime().fieldName('updated_at').columnType('timestamptz').defaultRaw('now()'),
  },
  uniques: [
    { name: 'wager_tx_provider_external_unique', properties: ['providerId', 'externalTransactionId'] },
    { name: 'wager_tx_idempotency_key_unique', properties: ['idempotencyKey'] },
    {
      // A processed transaction has at most one processed reversal, REFUND or ROLLBACK (stricter than "per type":
      // two reversal types would return the same money twice). Last line of defence behind the domain rule.
      name: 'wager_tx_one_reversal_per_reference',
      expression:
        "create unique index wager_tx_one_reversal_per_reference on wager_transactions (reference_transaction_id) where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED'",
    },
  ],
  indexes: [
    { name: 'wager_tx_game_created', properties: ['gameId', 'createdAt'] },
    {
      name: 'wager_tx_pending_reference_due',
      expression:
        "create index wager_tx_pending_reference_due on wager_transactions (next_retry_at) where status = 'PENDING_REFERENCE'",
    },
  ],
  checks: [
    { name: 'wager_tx_kind_valid', expression: "kind in ('BET','WIN','LOSS','REFUND','ROLLBACK','OPENING')" },
    {
      name: 'wager_tx_status_valid',
      expression: "status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')",
    },
    { name: 'wager_tx_amount_valid', expression: 'amount >= 0' },
    {
      name: 'wager_tx_reversal_has_reference',
      expression: "kind not in ('REFUND','ROLLBACK') or reference_external_id is not null",
    },
  ],
});

export const LedgerEntry = defineEntity({
  name: 'LedgerEntry',
  tableName: 'ledger_entries',
  properties: {
    /** Insert-order cursor used by the paginated ledger endpoint. */
    seq: p.bigint('string').primary().autoincrement(),
    id: p.uuid().unique(),
    wallet: () => p.manyToOne(Wallet).mapToPk().fieldName('wallet_id'),
    transaction: () => p.manyToOne(WagerTransaction).mapToPk().fieldName('transaction_id'),
    direction: p.text(),
    amount: p.decimal('string').columnType('numeric(18,2)'),
    balanceBefore: p.decimal('string').fieldName('balance_before').columnType('numeric(18,2)'),
    balanceAfter: p.decimal('string').fieldName('balance_after').columnType('numeric(18,2)'),
    createdAt: p.datetime().fieldName('created_at').columnType('timestamptz').defaultRaw('now()'),
  },
  uniques: [{ name: 'ledger_one_entry_per_wallet_tx', properties: ['wallet', 'transaction'] }],
  indexes: [{ name: 'ledger_entries_wallet_seq', properties: ['wallet', 'seq'] }],
  checks: [
    { name: 'ledger_direction_valid', expression: "direction in ('CREDIT','DEBIT')" },
    { name: 'ledger_amount_positive', expression: 'amount > 0' },
    { name: 'ledger_balance_after_non_negative', expression: 'balance_after >= 0' },
    { name: 'ledger_balance_before_non_negative', expression: 'balance_before >= 0' },
    {
      // The entry must be arithmetically consistent: before ± amount = after.
      name: 'ledger_balance_arithmetic',
      expression:
        "(direction = 'CREDIT' and balance_after = balance_before + amount) or (direction = 'DEBIT' and balance_after = balance_before - amount)",
    },
  ],
  triggers: [
    {
      // Append-only ledger: rows can never be updated or deleted, by anyone, including the application.
      name: 'ledger_entries_no_update_delete',
      timing: 'before',
      events: ['update', 'delete'],
      forEach: 'row',
      body: "raise exception 'ledger_entries is append-only';",
    },
  ],
});

export const InboxMessage = defineEntity({
  name: 'InboxMessage',
  tableName: 'inbox_messages',
  properties: {
    consumer: p.text().primary(),
    messageId: p.text().fieldName('message_id').primary(),
    /** Hash of the message content, so a reused message id with different content is detected, not swallowed. */
    payloadHash: p.text().fieldName('payload_hash').nullable(),
    receivedAt: p.datetime().fieldName('received_at').columnType('timestamptz').defaultRaw('now()'),
  },
});

export const OutboxEvent = defineEntity({
  name: 'OutboxEvent',
  tableName: 'outbox_events',
  properties: {
    // seq is assigned at insert time, i.e. under the wallet row lock, so for one aggregate it follows the real
    // order of changes (created_at would be the transaction start time and could invert).
    seq: p.bigint('string').primary().autoincrement(),
    id: p.uuid().unique(),
    aggregateId: p.text().fieldName('aggregate_id'),
    eventType: p.text().fieldName('event_type'),
    version: p.integer(),
    payload: p.json<Record<string, unknown>>().columnType('jsonb'),
    createdAt: p.datetime().fieldName('created_at').columnType('timestamptz').defaultRaw('now()'),
    publishedAt: p.datetime().fieldName('published_at').columnType('timestamptz').nullable(),
    attempts: p.integer().default(0),
    lastError: p.text().fieldName('last_error').nullable(),
    /** After a refused publish: not claimable before this instant (database clock). */
    nextAttemptAt: p.datetime().fieldName('next_attempt_at').columnType('timestamptz').nullable(),
    /** Gave up after too many refusals; no longer blocks its aggregate, needs a human. */
    deadAt: p.datetime().fieldName('dead_at').columnType('timestamptz').nullable(),
  },
  indexes: [
    {
      name: 'outbox_events_unpublished',
      expression:
        'create index outbox_events_unpublished on outbox_events (seq) where published_at is null and dead_at is null',
    },
    {
      name: 'outbox_events_unpublished_by_aggregate',
      expression:
        'create index outbox_events_unpublished_by_aggregate on outbox_events (aggregate_id, seq) where published_at is null and dead_at is null',
    },
  ],
  checks: [{ name: 'outbox_not_published_and_dead', expression: 'published_at is null or dead_at is null' }],
});

export const entities = [Wallet, WagerTransaction, LedgerEntry, InboxMessage, OutboxEvent];

export type WalletEntity = InferEntity<typeof Wallet>;
export type WagerTransactionEntity = InferEntity<typeof WagerTransaction>;
export type LedgerEntryEntity = InferEntity<typeof LedgerEntry>;
export type InboxMessageEntity = InferEntity<typeof InboxMessage>;
export type OutboxEventEntity = InferEntity<typeof OutboxEvent>;
