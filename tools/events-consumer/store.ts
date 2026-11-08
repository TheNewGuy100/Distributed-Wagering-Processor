/**
 * What a downstream consumer of the outbox events has to do, in one place:
 *
 *  - parse and validate the envelope (a malformed message must not stall the queue);
 *  - DEDUPLICATE by `eventId`: delivery is at-least-once (a publisher that dies between sending and committing sends
 *    again, and the broker only deduplicates inside a 5-minute window);
 *  - check per-wallet order using `walletVersion` (WalletBalanceChanged events carry it so consumers can detect gaps
 *    or reordering even across publisher failures). A skipped version is a GAP, not an error: the publisher may be
 *    late, or the missing event may have gone DEAD for good. A gap is remembered; if the version shows up later it
 *    fills the gap (`lateFill`), and only a repeated or already-filled version counts as out of order.
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
  /** This event skipped over versions that have not arrived (yet). */
  gap?: { from: number; to: number };
  /** This event arrived after a later one and completed a previously reported gap. */
  lateFill?: boolean;
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
  /** Wallet versions currently missing (skipped and not filled in later). */
  openGaps: number;
  byType: Record<string, number>;
}

const MAX_RECENT = 300;
const MAX_SEEN = 20_000;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export class EventStore {
  readonly stats: Stats = { received: 0, unique: 0, duplicates: 0, invalid: 0, outOfOrder: 0, openGaps: 0, byType: {} };
  private recent: EventRecord[] = [];
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private lastWalletVersion = new Map<string, number>();
  private missingVersions = new Map<string, Set<number>>();
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
    let gap: { from: number; to: number } | undefined;
    let lateFill = false;
    const walletVersion = parsed.data.walletVersion;
    if (parsed.eventType === 'WalletBalanceChanged' && typeof walletVersion === 'number') {
      // A wallet starts at version 1, but an empty wallet emits no event for it (its first event is version 2), and a
      // consumer may join late: the first version seen for a wallet is the baseline, gaps are counted from there on.
      const last = this.lastWalletVersion.get(parsed.aggregateId) ?? walletVersion - 1;
      const missing = this.missingVersions.get(parsed.aggregateId);
      if (walletVersion > last) {
        if (walletVersion > last + 1) {
          // Skipped versions: remember them, they may still arrive (late) or never (a DEAD event).
          gap = { from: last + 1, to: walletVersion - 1 };
          const set = missing ?? new Set<number>();
          for (let v = gap.from; v <= gap.to; v++) set.add(v);
          this.missingVersions.set(parsed.aggregateId, set);
          this.stats.openGaps += gap.to - gap.from + 1;
        }
        this.lastWalletVersion.set(parsed.aggregateId, walletVersion);
      } else if (missing?.delete(walletVersion)) {
        lateFill = true; // arrived after a later version, but it was the one we were waiting for
        this.stats.openGaps--;
      } else {
        outOfOrder = true; // repeated version under a new event id
      }
    }
    this.stats.unique++;
    this.stats.byType[parsed.eventType] = (this.stats.byType[parsed.eventType] ?? 0) + 1;
    if (outOfOrder) this.stats.outOfOrder++;
    return this.keep({
      ...event,
      status: 'new',
      ...(outOfOrder ? { outOfOrder } : {}),
      ...(gap ? { gap } : {}),
      ...(lateFill ? { lateFill } : {}),
    });
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
