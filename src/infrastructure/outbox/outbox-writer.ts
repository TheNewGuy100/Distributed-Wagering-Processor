import type { EntityManager } from '@mikro-orm/postgresql';
import type { DomainEvent } from '../../domain/events';
import { OutboxEvent } from '../persistence/entities';

/** Appends events to the outbox using the caller's transaction, so they commit atomically with the change. */
export async function enqueueEvent(tx: EntityManager, event: DomainEvent): Promise<void> {
  await tx.insert(OutboxEvent, {
    id: event.eventId,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    version: event.version,
    payload: event.toEnvelope(),
  });
}
