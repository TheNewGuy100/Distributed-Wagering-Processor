import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxMessage, InboxVerdict } from '../domain/inbox-message';

/** Port: records a received message in the caller's SQL transaction and says whether it is new. */
export abstract class InboxRepository {
  abstract record(tx: EntityManager, message: InboxMessage): Promise<InboxVerdict>;
}
