import { describe, expect, test } from 'bun:test';
import { Money } from './money';
import { applyDecision, type ReferenceSnapshot, type TransactionKind, type TransactionStatus } from './wager-rules';
import { planSettlement, type Settlement } from './wager-transaction';
import { balanceFromLedger, Wallet, type LedgerEntryDraft } from './wallet';

/**
 * Model-based test of the pure domain: thousands of random operation sequences (valid, invalid, mismatching,
 * unknown references, exhausted retries) are settled against one wallet, and after EVERY step the invariants of the
 * challenge are checked against an independent model that only looks at the final statuses.
 */

/** Small deterministic PRNG so a failing seed reproduces exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Tx {
  id: string;
  ext: string;
  kind: TransactionKind;
  amount: Money;
  roundId: string;
  status: TransactionStatus;
  reference: Tx | null;
}

const BRL = 'BRL';
const brl = (cents: number) => Money.fromMinor(BigInt(cents), BRL);

function run(seed: number, steps: number): void {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const wallet = Wallet.rehydrate({ id: 'w', playerId: 'p', balance: brl(5_000), version: 0 });
  const opening = wallet.balance;
  const ledger: LedgerEntryDraft[] = [];
  const all: Tx[] = [];
  const byExt = new Map<string, Tx>();
  const policy = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 4 };

  const snapshot = (ref: Tx): ReferenceSnapshot => ({
    id: ref.id,
    providerId: 'pv',
    playerId: 'p',
    walletId: 'w',
    currency: BRL,
    roundId: ref.roundId,
    gameId: 'g',
    kind: ref.kind,
    status: ref.status,
    amount: ref.amount,
    reversedBy: all.filter((t) => t.reference === ref && t.status === 'PROCESSED').map((t) => t.kind),
  });

  for (let i = 0; i < steps; i++) {
    const kind = pick<TransactionKind>(['BET', 'BET', 'WIN', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']);
    const reversal = kind === 'REFUND' || kind === 'ROLLBACK';
    const target = reversal && all.length > 0 && rnd() < 0.85 ? pick(all) : null;
    // Reversals mostly mirror their target; sometimes the amount or round is wrong on purpose.
    const amount = target && rnd() < 0.8 ? target.amount : brl(1 + Math.floor(rnd() * 3_000));
    const roundId = target && rnd() < 0.9 ? target.roundId : `r${Math.floor(rnd() * 5)}`;
    const tx: Tx = {
      id: `t${i}`,
      ext: `e${i}`,
      kind,
      amount: kind === 'LOSS' && rnd() < 0.5 ? Money.zero(BRL) : amount,
      roundId,
      status: 'PENDING',
      reference: null,
    };
    all.push(tx);
    byExt.set(tx.ext, tx);

    let retryCount = 0;
    let fromStatus: 'PENDING' | 'PENDING_REFERENCE' = 'PENDING';
    for (let attempt = 0; attempt < 6; attempt++) {
      const ref = reversal && target ? snapshot(target) : null;
      const plan: Settlement = planSettlement(
        {
          kind,
          providerId: 'pv',
          playerId: 'p',
          currency: BRL,
          amount: tx.amount,
          roundId: tx.roundId,
          referenceExternalId: target ? target.ext : null,
          gameId: null,
          fromStatus,
          retryCount,
        },
        wallet,
        ref,
        new Date(0),
        policy,
      );
      if (plan.type === 'WAIT') {
        tx.status = 'PENDING_REFERENCE';
        fromStatus = 'PENDING_REFERENCE';
        retryCount = plan.retryCount;
        continue; // the worker comes back; the reference may have changed in between
      }
      const entry = applyDecision(wallet, tx.id, plan.decision);
      if (entry) ledger.push(entry);
      tx.status = plan.status;
      if (plan.status === 'PROCESSED') tx.reference = target;
      break;
    }

    checkInvariants(wallet, opening, ledger, all);
  }
}

function checkInvariants(wallet: Wallet, opening: Money, ledger: LedgerEntryDraft[], all: Tx[]): void {
  // 1. never negative (Money cannot even represent it, but the wallet must not have thrown either)
  expect(wallet.balance.minor >= 0n).toBe(true);

  // 2. the ledger explains the balance, entry by entry
  const net = ledger.reduce((sum, e) => sum + (e.direction === 'CREDIT' ? e.amount.minor : -e.amount.minor), 0n);
  expect(wallet.balance.minor).toBe(opening.minor + net);
  // the production reconciliation helper agrees whenever the net is representable (it cannot hold a negative Money)
  if (net >= 0n) expect(balanceFromLedger(BRL, ledger).minor).toBe(net);
  let running = opening.minor;
  for (const e of ledger) {
    expect(e.balanceBefore.minor).toBe(running);
    running += e.direction === 'CREDIT' ? e.amount.minor : -e.amount.minor;
    expect(e.balanceAfter.minor).toBe(running);
  }
  expect(wallet.version).toBe(ledger.length);

  // 3. an independent model that only reads statuses must agree with the balance
  let expected = opening.minor;
  const processed = all.filter((t) => t.status === 'PROCESSED');
  for (const t of processed) {
    if (t.kind === 'BET') expected -= t.amount.minor;
    else if (t.kind === 'WIN') expected += t.amount.minor;
    else if (t.kind === 'REFUND' || t.kind === 'ROLLBACK') {
      expected += t.reference!.kind === 'BET' ? t.amount.minor : -t.amount.minor;
    }
  }
  expect(wallet.balance.minor).toBe(expected);

  // 4. every transaction is reversed at most once, whatever the reversal type
  const reversed = new Map<string, number>();
  for (const t of processed) if (t.reference) reversed.set(t.reference.id, (reversed.get(t.reference.id) ?? 0) + 1);
  for (const n of reversed.values()) expect(n).toBe(1);

  // 5. a reversal only ever points at a processed BET/WIN of the same amount
  for (const t of processed) {
    if (!t.reference) continue;
    expect(['BET', 'WIN']).toContain(t.reference.kind);
    expect(t.reference.status).toBe('PROCESSED');
    expect(t.amount.minor).toBe(t.reference.amount.minor);
  }

  // 6. final statuses never leave the ledger behind: one entry per money-moving processed transaction
  const moving = processed.filter((t) => t.kind !== 'LOSS');
  expect(ledger.length).toBe(moving.length);
}

describe('settlement invariants (random sequences)', () => {
  test('hold after every step, for 300 seeds of 120 operations', () => {
    for (let seed = 1; seed <= 300; seed++) {
      try {
        run(seed, 120);
      } catch (e) {
        throw new Error(`invariant broken for seed ${seed}: ${(e as Error).message}`);
      }
    }
  });
});

describe('planSettlement', () => {
  const wallet = () => Wallet.rehydrate({ id: 'w', playerId: 'p', balance: brl(1_000), version: 0 });
  const req = (over: Partial<Parameters<typeof planSettlement>[0]> = {}): Parameters<typeof planSettlement>[0] => ({
    kind: 'REFUND',
    providerId: 'pv',
    playerId: 'p',
    currency: BRL,
    amount: brl(500),
    roundId: 'r',
    referenceExternalId: 'bet',
    gameId: null,
    fromStatus: 'PENDING',
    retryCount: 0,
    ...over,
  });

  test('a reversal without its reference waits, and announces the wait only the first time', () => {
    const first = planSettlement(req(), wallet(), null, new Date(0));
    expect(first).toMatchObject({ type: 'WAIT', retryCount: 1, announce: true });
    const later = planSettlement(req({ fromStatus: 'PENDING_REFERENCE', retryCount: 1 }), wallet(), null, new Date(0));
    expect(later).toMatchObject({ type: 'WAIT', retryCount: 2, announce: false });
  });

  test('an exhausted retry budget becomes a rejection with the reason it was waiting for', () => {
    const policy = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 };
    const missing = planSettlement(req({ fromStatus: 'PENDING_REFERENCE', retryCount: 2 }), wallet(), null, new Date(0), policy);
    expect(missing).toMatchObject({ type: 'SETTLE', status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
  });

  test('a reversal inherits the game of its reference', () => {
    const ref: ReferenceSnapshot = {
      id: 'b',
      providerId: 'pv',
      playerId: 'p',
      walletId: 'w',
      currency: BRL,
      roundId: 'r',
      gameId: 'fortune-chimp',
      kind: 'BET',
      status: 'PROCESSED',
      amount: brl(500),
      reversedBy: [],
    };
    expect(planSettlement(req(), wallet(), ref, new Date(0))).toMatchObject({
      type: 'SETTLE',
      status: 'PROCESSED',
      gameId: 'fortune-chimp',
    });
  });

  test('refuses to leave a final status', () => {
    expect(() => planSettlement(req({ kind: 'LOSS', referenceExternalId: null, fromStatus: 'PROCESSED' as never }), wallet(), null, new Date(0))).toThrow();
  });
});
