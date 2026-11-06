import { Migration } from '@mikro-orm/migrations';

/**
 * Hand-written on purpose. The ledger is append-only: the row-level trigger (UPDATE/DELETE) is declared on the
 * `LedgerEntry` entity, but MikroORM's schema introspection does not see statement-level TRUNCATE triggers, so
 * declaring this one on the entity would produce a permanent schema diff. It is guarded by the catalog test
 * (`schema-guarantees.test.ts`) instead.
 */
export class Migration20261106000100_ledger_truncate_guard extends Migration {
  override name = 'Migration20261106000100_ledger_truncate_guard';

  override up(): void {
    this.addSql(`
      create or replace function ledger_entries_no_truncate_fn() returns trigger as $$
      begin
        raise exception 'ledger_entries is append-only';
      end;
      $$ language plpgsql;
    `);
    this.addSql(`
      create trigger ledger_entries_no_truncate
        before truncate on ledger_entries
        for each statement execute function ledger_entries_no_truncate_fn();
    `);
  }

  override down(): void {
    this.addSql(`drop trigger if exists ledger_entries_no_truncate on ledger_entries;`);
    this.addSql(`drop function if exists ledger_entries_no_truncate_fn();`);
  }
}
