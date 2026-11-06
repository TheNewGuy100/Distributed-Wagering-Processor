import { Migration } from '@mikro-orm/migrations';

export class Migration20261106000000_initial_schema extends Migration {

  override name = 'Migration20261106000000_initial_schema';

  override up(): void | Promise<void> {
    this.addSql(`create table "inbox_messages" ("consumer" text not null, "message_id" text not null, "received_at" timestamptz not null default now(), primary key ("consumer", "message_id"));`);

    this.addSql(`create table "outbox_events" ("seq" bigserial primary key, "id" uuid not null, "aggregate_id" text not null, "event_type" text not null, "version" int not null, "payload" jsonb not null, "created_at" timestamptz not null default now(), "published_at" timestamptz null, "attempts" int not null default 0, "last_error" text null);`);
    this.addSql(`alter table "outbox_events" add constraint "outbox_events_id_unique" unique ("id");`);
    this.addSql(`create index outbox_events_unpublished on outbox_events (seq) where published_at is null;`);
    this.addSql(`create index outbox_events_unpublished_by_aggregate on outbox_events (aggregate_id, seq) where published_at is null;`);

    this.addSql(`create table "wallets" ("id" uuid not null, "player_id" text not null, "currency" char(3) not null, "balance" numeric(18,2) not null default '0', "version" bigint not null default '0', "created_at" timestamptz not null default now(), "flagged_at" timestamptz null, "flag_reason" text null, primary key ("id"));`);
    this.addSql(`alter table "wallets" add constraint "wallets_player_currency_unique" unique ("player_id", "currency");`);
    this.addSql(`alter table "wallets" add constraint "wallets_balance_non_negative" check (balance >= 0);`);

    this.addSql(`create table "wager_transactions" ("id" uuid not null, "provider_id" text not null, "external_transaction_id" text not null, "idempotency_key" text not null, "payload_hash" text not null, "kind" text not null, "status" text not null, "player_id" text not null, "currency" char(3) not null, "amount" numeric(18,2) not null, "round_id" text null, "wallet_id" uuid null, "reference_external_id" text null, "reference_transaction_id" uuid null, "failure_code" text null, "retry_count" int not null default 0, "next_retry_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), primary key ("id"));`);
    this.addSql(`create index wager_tx_pending_reference_due on wager_transactions (next_retry_at) where status = 'PENDING_REFERENCE';`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_tx_provider_external_unique" unique ("provider_id", "external_transaction_id");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_tx_idempotency_key_unique" unique ("idempotency_key");`);
    this.addSql(`create unique index wager_tx_one_reversal_per_reference on wager_transactions (reference_transaction_id) where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED';`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_tx_kind_valid" check (kind in ('BET','WIN','LOSS','REFUND','ROLLBACK','OPENING'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_tx_status_valid" check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_tx_amount_valid" check (amount >= 0);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_tx_reversal_has_reference" check (kind not in ('REFUND','ROLLBACK') or reference_external_id is not null);`);

    this.addSql(`create table "ledger_entries" ("seq" bigserial primary key, "id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" text not null, "amount" numeric(18,2) not null, "balance_after" numeric(18,2) not null, "created_at" timestamptz not null default now());`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_entries_id_unique" unique ("id");`);
    this.addSql(`create index "ledger_entries_wallet_seq" on "ledger_entries" ("wallet_id", "seq");`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_one_entry_per_wallet_tx" unique ("wallet_id", "transaction_id");`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_direction_valid" check (direction in ('CREDIT','DEBIT'));`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_amount_positive" check (amount > 0);`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_balance_after_non_negative" check (balance_after >= 0);`);
    this.addSql(`create or replace function "ledger_entries_ledger_entries_no_update_delete_fn"() returns trigger as \$\$ begin raise exception 'ledger_entries is append-only'; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "ledger_entries_no_update_delete" BEFORE UPDATE OR DELETE on "ledger_entries" for each ROW execute function "ledger_entries_ledger_entries_no_update_delete_fn"();`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete no action;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on delete no action;`);

    this.addSql(`alter table "ledger_entries" add constraint "ledger_entries_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id");`);
    this.addSql(`alter table "ledger_entries" add constraint "ledger_entries_transaction_id_foreign" foreign key ("transaction_id") references "wager_transactions" ("id");`);
  }

  // Generated migrations have no down(); every migration in this project must be reversible
  // (CI runs up, down, up and a unit test checks that each migration defines down()).
  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "outbox_events" cascade;`);
    this.addSql(`drop table if exists "inbox_messages" cascade;`);
    this.addSql(`drop table if exists "ledger_entries" cascade;`);
    this.addSql(`drop function if exists "ledger_entries_ledger_entries_no_update_delete_fn"();`);
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
    this.addSql(`drop table if exists "wallets" cascade;`);
  }

}
