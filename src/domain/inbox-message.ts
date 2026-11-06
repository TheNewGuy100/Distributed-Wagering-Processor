import { createHash } from 'node:crypto';
import { canonicalJson } from './idempotency';

/**
 * What the inbox says about an incoming message:
 *  - NEW:              first time this (consumer, messageId) is seen; process it
 *  - DUPLICATE:        seen before with the same content (a redelivery); acknowledge, do nothing
 *  - PAYLOAD_CONFLICT: seen before with DIFFERENT content: the producer reused a message id. Never process it
 *                      silently as a duplicate, that would drop a distinct business message.
 */
export type InboxVerdict = 'NEW' | 'DUPLICATE' | 'PAYLOAD_CONFLICT';

/** A message as the consumer received it. Identity is (consumer, messageId); the hash pins its content. */
export class InboxMessage {
  private constructor(
    readonly consumer: string,
    readonly messageId: string,
    readonly payloadHash: string,
  ) {}

  /** `payload` is the business content (the envelope's `type` and `data`), hashed as canonical JSON. */
  static receive(consumer: string, messageId: string, payload: unknown): InboxMessage {
    if (consumer.trim() === '' || messageId.trim() === '') throw new Error('consumer and messageId are required');
    const hash = createHash('sha256').update(canonicalJson(payload)).digest('hex');
    return new InboxMessage(consumer, messageId, hash);
  }

  /** Judges this message against what the inbox already stored for the same identity (null when nothing). */
  judge(stored: { payloadHash: string | null } | null): InboxVerdict {
    if (stored === null) return 'NEW';
    // Rows written before the hash existed carry none: treat them as plain duplicates.
    if (stored.payloadHash === null || stored.payloadHash === this.payloadHash) return 'DUPLICATE';
    return 'PAYLOAD_CONFLICT';
  }
}
