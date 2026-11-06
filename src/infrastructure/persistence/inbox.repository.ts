import type { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { InboxRepository } from '../../application/inbox.repository';
import type { InboxMessage, InboxVerdict } from '../../domain/inbox-message';
import { InboxMessage as InboxSchema } from './entities';
import { insertIgnoringConflict } from './orm-helpers';

@Injectable()
export class SqlInboxRepository extends InboxRepository {
  /**
   * The primary key (consumer, message id) decides the race: a redelivered or concurrent copy inserts nothing and
   * blocks on the unique index until the first one commits, then reads what it stored.
   */
  async record(tx: EntityManager, message: InboxMessage): Promise<InboxVerdict> {
    const inserted = await insertIgnoringConflict(
      tx,
      InboxSchema,
      { consumer: message.consumer, messageId: message.messageId, payloadHash: message.payloadHash },
      'messageId',
    );
    if (inserted) return 'NEW';
    const stored = await tx.findOne(
      InboxSchema,
      { consumer: message.consumer, messageId: message.messageId },
      { fields: ['payloadHash'], refresh: true },
    );
    return message.judge(stored ? { payloadHash: stored.payloadHash ?? null } : null);
  }
}
