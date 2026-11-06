import { Migration } from '@mikro-orm/migrations';

export class Migration20261106000000_initial_schema extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id text not null,
        currency char(3) not null,
        balance numeric(18,2) not null default 0,
        version bigint not null default 0,
        created_at timestamptz not null default now(),
        -- set by reconciliation when stored and recomputed balances diverge; never auto-cleared
        flagged_at timestamptz,
        flag_reason text,
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_player_currency_unique unique (player_id, currency)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        kind text not null,
        status text not null,
        player_id text not null,
        currency char(3) not null,
        amount numeric(18,2) not null,
        round_id text,
        wallet_id uuid references wallets(id),
        reference_external_id text,
        reference_transaction_id uuid references wager_transactions(id),
        failure_code text,
        retry_count int not null default 0,
        next_retry_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint wager_tx_kind_valid check (kind in ('BET','WIN','LOSS','REFUND','ROLLBACK','OPENING')),
        constraint wager_tx_status_valid check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint wager_tx_amount_valid check (amount >= 0),
        constraint wager_tx_provider_external_unique unique (provider_id, external_transaction_id),
        constraint wager_tx_idempotency_key_unique unique (idempotency_key),
        constraint wager_tx_reversal_has_reference check (
          kind not in ('REFUND','ROLLBACK') or reference_external_id is not null
        )
      );
    `);
    // A processed transaction can be reversed at most once, by either REFUND or ROLLBACK
    // (stricter than "once per type": two reversal types would return the same money twice).
    this.addSql(`
      create unique index wager_tx_one_reversal_per_reference
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED';
    `);
    this.addSql(`
      create index wager_tx_pending_reference_due
        on wager_transactions (next_retry_at)
        where status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      create table ledger_entries (
        seq bigint generated always as identity primary key,
        id uuid not null unique,
        wallet_id uuid not null references wallets(id),
        transaction_id uuid not null references wager_transactions(id),
        direction text not null,
        amount numeric(18,2) not null,
        balance_after numeric(18,2) not null,
        created_at timestamptz not null default now(),
        constraint ledger_direction_valid check (direction in ('CREDIT','DEBIT')),
        constraint ledger_amount_positive check (amount > 0),
        constraint ledger_balance_after_non_negative check (balance_after >= 0),
        constraint ledger_one_entry_per_wallet_tx unique (wallet_id, transaction_id)
      );
    `);
    this.addSql(`create index ledger_entries_wallet_seq on ledger_entries (wallet_id, seq);`);
    // Append-only: no updates, deletes or truncates, ever.
    this.addSql(`
      create function ledger_entries_immutable() returns trigger as $$
      begin
        raise exception 'ledger_entries is append-only';
      end;
      $$ language plpgsql;
    `);
    this.addSql(`
      create trigger ledger_entries_no_update_delete
        before update or delete on ledger_entries
        for each row execute function ledger_entries_immutable();
    `);
    this.addSql(`
      create trigger ledger_entries_no_truncate
        before truncate on ledger_entries
        for each statement execute function ledger_entries_immutable();
    `);

    this.addSql(`
      create table inbox_messages (
        consumer text not null,
        message_id text not null,
        received_at timestamptz not null default now(),
        primary key (consumer, message_id)
      );
    `);

    this.addSql(`
      create table outbox_events (
        -- seq is assigned at insert time, i.e. under the wallet row lock, so for one aggregate it
        -- follows the real order of changes (created_at would be the transaction start time).
        seq bigint generated always as identity primary key,
        id uuid not null unique,
        aggregate_id text not null,
        event_type text not null,
        version int not null,
        payload jsonb not null,
        created_at timestamptz not null default now(),
        published_at timestamptz,
        attempts int not null default 0,
        last_error text
      );
    `);
    this.addSql(`
      create index outbox_events_unpublished on outbox_events (seq) where published_at is null;
    `);
    this.addSql(`
      create index outbox_events_unpublished_by_aggregate
        on outbox_events (aggregate_id, seq) where published_at is null;
    `);
  }

  override down(): void {
    this.addSql(`drop table if exists outbox_events;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists ledger_entries;`);
    this.addSql(`drop function if exists ledger_entries_immutable();`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop table if exists wallets;`);
  }
}
