import { Migration } from '@mikro-orm/migrations';

export class Migration20261106182336_wager_tx_correlation_id extends Migration {

  override name = 'Migration20261106182336_wager_tx_correlation_id';

  override up(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" add "correlation_id" text null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" drop column "correlation_id";`);
  }

}
