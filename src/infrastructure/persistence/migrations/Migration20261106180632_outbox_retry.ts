import { Migration } from '@mikro-orm/migrations';

export class Migration20261106180632_outbox_retry extends Migration {

  override name = 'Migration20261106180632_outbox_retry';

  override up(): void | Promise<void> {
    this.addSql(`alter table "outbox_events" add "next_attempt_at" timestamptz null, add "dead_at" timestamptz null;`);
    this.addSql(`alter table "outbox_events" add constraint "outbox_not_published_and_dead" check (published_at is null or dead_at is null);`);
    // Partial indexes (the schema diff cannot see raw index expressions): a DEAD row is no longer part of the live queue.
    this.addSql(`drop index outbox_events_unpublished;`);
    this.addSql(`drop index outbox_events_unpublished_by_aggregate;`);
    this.addSql(`create index outbox_events_unpublished on outbox_events (seq) where published_at is null and dead_at is null;`);
    this.addSql(`create index outbox_events_unpublished_by_aggregate on outbox_events (aggregate_id, seq) where published_at is null and dead_at is null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index outbox_events_unpublished;`);
    this.addSql(`drop index outbox_events_unpublished_by_aggregate;`);
    this.addSql(`create index outbox_events_unpublished on outbox_events (seq) where published_at is null;`);
    this.addSql(`create index outbox_events_unpublished_by_aggregate on outbox_events (aggregate_id, seq) where published_at is null;`);
    this.addSql(`alter table "outbox_events" drop constraint "outbox_not_published_and_dead";`);
    this.addSql(`alter table "outbox_events" drop column "next_attempt_at", drop column "dead_at";`);
  }

}
