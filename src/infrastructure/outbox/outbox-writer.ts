import type { EntityManager } from '@mikro-orm/postgresql';
import type { DomainEvent } from '../../domain/events';
import { OutboxEvent } from '../persistence/entities';

const toRow = (event: DomainEvent) => ({
  id: event.eventId,
  aggregateId: event.aggregateId,
  eventType: event.eventType,
  version: event.version,
  payload: event.toEnvelope(),
});

/**
 * Appends events to the outbox using the caller's transaction, so they commit atomically with the change.
 * Several events go in ONE multi-row insert (one round trip); rows keep the given order.
 */
export async function enqueueEvents(tx: EntityManager, events: readonly DomainEvent[]): Promise<void> {
  if (events.length === 0) return;
  if (events.length === 1) await tx.insert(OutboxEvent, toRow(events[0]!));
  else await tx.insertMany(OutboxEvent, events.map(toRow));
}

export const enqueueEvent = (tx: EntityManager, event: DomainEvent): Promise<void> => enqueueEvents(tx, [event]);
