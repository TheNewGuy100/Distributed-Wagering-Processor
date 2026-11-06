import type { EntityManager } from '@mikro-orm/postgresql';
import type { DomainEvent } from '../../domain/events';

/** Appends events to the outbox using the caller's transaction, so they commit atomically with the change. */
export async function enqueueEvent(tx: EntityManager, event: DomainEvent): Promise<void> {
  await tx.execute(
    `insert into outbox_events (id, aggregate_id, event_type, version, payload)
     values (?, ?, ?, ?, ?::jsonb)`,
    [event.eventId, event.aggregateId, event.eventType, event.version, JSON.stringify(event.toEnvelope())],
  );
}
