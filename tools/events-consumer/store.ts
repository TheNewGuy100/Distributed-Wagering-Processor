/**
 * What a downstream consumer of the outbox events has to do, in one place:
 *
 *  - parse and validate the envelope (a malformed message must not stall the queue);
 *  - DEDUPLICATE by `eventId`: delivery is at-least-once (a publisher that dies between sending and committing sends
 *    again, and the broker only deduplicates inside a 5-minute window);
 *  - check per-wallet order using `walletVersion` (WalletBalanceChanged events carry it so consumers can detect gaps
 *    or reordering even across publisher failures).
 */
export interface EventRecord {
  /** Monotonic counter, used by the page to ask only for what is new. */
  n: number;
  receivedAt: string;
  messageId: string;
  /** `invalid`: not a well-formed event envelope. `duplicate`: an eventId that was already seen. */
  status: 'new' | 'duplicate' | 'invalid';
  reason?: string;
  outOfOrder?: boolean;
  eventId?: string;
  eventType?: string;
  version?: number;
  aggregateId?: string;
  occurredAt?: string;
  data?: Record<string, unknown>;
}

export interface Stats {
  received: number;
  unique: number;
  duplicates: number;
  invalid: number;
  outOfOrder: number;
  byType: Record<string, number>;
}

const MAX_RECENT = 300;
const MAX_SEEN = 20_000;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export class EventStore {
  readonly stats: Stats = { received: 0, unique: 0, duplicates: 0, invalid: 0, outOfOrder: 0, byType: {} };
  private recent: EventRecord[] = [];
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private lastWalletVersion = new Map<string, number>();
  private counter = 0;

  ingest(messageId: string, body: string, now: Date = new Date()): EventRecord {
    this.stats.received++;
    const base = { n: ++this.counter, receivedAt: now.toISOString(), messageId };

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return this.keep({ ...base, status: 'invalid', reason: 'not JSON' });
    }
    if (
      !isObject(parsed) ||
      !isString(parsed.eventId) ||
      !isString(parsed.eventType) ||
      !isString(parsed.aggregateId) ||
      typeof parsed.version !== 'number' ||
      !isString(parsed.occurredAt) ||
      !isObject(parsed.data)
    ) {
      return this.keep({ ...base, status: 'invalid', reason: 'not an event envelope' });
    }

    const event = {
      ...base,
      eventId: parsed.eventId,
      eventType: parsed.eventType,
      version: parsed.version,
      aggregateId: parsed.aggregateId,
      occurredAt: parsed.occurredAt,
      data: parsed.data,
    };

    if (this.seen.has(parsed.eventId)) return this.keep({ ...event, status: 'duplicate' });
    this.remember(parsed.eventId);

    let outOfOrder = false;
    const walletVersion = parsed.data.walletVersion;
    if (parsed.eventType === 'WalletBalanceChanged' && typeof walletVersion === 'number') {
      const last = this.lastWalletVersion.get(parsed.aggregateId) ?? 0;
      // Versions of one wallet must arrive strictly increasing. (A gap is allowed: other events of the wallet may
      // not have been consumed yet; going backwards or repeating is not.)
      if (walletVersion <= last) outOfOrder = true;
      else this.lastWalletVersion.set(parsed.aggregateId, walletVersion);
    }
    this.stats.unique++;
    this.stats.byType[parsed.eventType] = (this.stats.byType[parsed.eventType] ?? 0) + 1;
    if (outOfOrder) this.stats.outOfOrder++;
    return this.keep({ ...event, status: 'new', ...(outOfOrder ? { outOfOrder } : {}) });
  }

  /** Newest first, only entries after `since`. */
  since(since: number, limit = 100): EventRecord[] {
    return this.recent.filter((e) => e.n > since).slice(-limit).reverse();
  }

  private keep(record: EventRecord): EventRecord {
    if (record.status === 'duplicate') this.stats.duplicates++;
    if (record.status === 'invalid') this.stats.invalid++;
    this.recent.push(record);
    if (this.recent.length > MAX_RECENT) this.recent.shift();
    return record;
  }

  private remember(eventId: string): void {
    this.seen.add(eventId);
    this.seenOrder.push(eventId);
    if (this.seenOrder.length > MAX_SEEN) this.seen.delete(this.seenOrder.shift()!);
  }
}
