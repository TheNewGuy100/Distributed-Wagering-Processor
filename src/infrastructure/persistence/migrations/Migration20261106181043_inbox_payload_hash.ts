import { Migration } from '@mikro-orm/migrations';

export class Migration20261106181043_inbox_payload_hash extends Migration {

  override name = 'Migration20261106181043_inbox_payload_hash';

  override up(): void | Promise<void> {
    this.addSql(`alter table "inbox_messages" add "payload_hash" text null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "inbox_messages" drop column "payload_hash";`);
  }

}
