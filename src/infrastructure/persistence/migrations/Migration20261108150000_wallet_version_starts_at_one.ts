import { Migration } from '@mikro-orm/migrations';

/**
 * A wallet is at version 1 from creation (the opening credit is part of creation); the version then increments with
 * every balance change. Before, it started at 0 and the opening credit counted as a change, so only wallets created
 * empty differ: existing rows are moved to the new numbering.
 */
export class Migration20261108150000_wallet_version_starts_at_one extends Migration {

  override name = 'Migration20261108150000_wallet_version_starts_at_one';

  override up(): void | Promise<void> {
    this.addSql(`alter table "wallets" alter column "version" set default '1';`);
    this.addSql(`
      update wallets w set version = w.version + 1 - (
        select count(*) from ledger_entries l join wager_transactions t on t.id = l.transaction_id
         where l.wallet_id = w.id and t.kind = 'OPENING'
      );
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`
      update wallets w set version = w.version - 1 + (
        select count(*) from ledger_entries l join wager_transactions t on t.id = l.transaction_id
         where l.wallet_id = w.id and t.kind = 'OPENING'
      );
    `);
    this.addSql(`alter table "wallets" alter column "version" set default '0';`);
  }

}
