import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvariantViolationError,
} from './errors';
import { Money } from './money';

export type LedgerDirection = 'CREDIT' | 'DEBIT';

/** A ledger entry produced by the aggregate, to be appended by the repository. */
export interface LedgerEntryDraft {
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly amount: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
}

export interface WalletSnapshot {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
}

/**
 * Aggregate root. Every balance change yields exactly one ledger entry, the balance
 * never goes negative, and `version` only increments when the balance changes.
 * Concurrency is handled by the persistence layer (row lock); the aggregate is single-threaded.
 */
export class Wallet {
  private _balance: Money;
  private _version: number;
  private readonly _entries: LedgerEntryDraft[] = [];
  private readonly _appliedTransactions = new Set<string>();

  private constructor(
    readonly id: string,
    readonly playerId: string,
    balance: Money,
    version: number,
  ) {
    this._balance = balance;
    this._version = version;
  }

  static open(id: string, playerId: string, currency: string): Wallet {
    return new Wallet(id, playerId, Money.zero(currency), 0);
  }

  static rehydrate(s: WalletSnapshot): Wallet {
    return new Wallet(s.id, s.playerId, s.balance, s.version);
  }

  get balance(): Money {
    return this._balance;
  }
  get currency(): string {
    return this._balance.currency;
  }
  get version(): number {
    return this._version;
  }
  /** Entries produced since load/open; the repository persists then clears them. */
  get pendingEntries(): readonly LedgerEntryDraft[] {
    return this._entries;
  }

  canDebit(amount: Money): boolean {
    return amount.currency === this.currency && !this._balance.isLessThan(amount);
  }

  credit(transactionId: string, amount: Money): LedgerEntryDraft {
    this.guard(transactionId, amount);
    return this.record(transactionId, 'CREDIT', amount, this._balance.add(amount));
  }

  debit(transactionId: string, amount: Money): LedgerEntryDraft {
    this.guard(transactionId, amount);
    if (!this.canDebit(amount)) throw new InsufficientFundsError();
    return this.record(transactionId, 'DEBIT', amount, this._balance.subtract(amount));
  }

  private guard(transactionId: string, amount: Money): void {
    if (amount.currency !== this.currency) throw new CurrencyMismatchError(this.currency, amount.currency);
    if (amount.isZero()) throw new InvalidMoneyError('ledger amount must be greater than zero');
    if (this._appliedTransactions.has(transactionId)) {
      throw new InvariantViolationError(`transaction ${transactionId} already has a ledger entry on this wallet`);
    }
  }

  private record(
    transactionId: string,
    direction: LedgerDirection,
    amount: Money,
    balanceAfter: Money,
  ): LedgerEntryDraft {
    const entry: LedgerEntryDraft = { transactionId, direction, amount, balanceBefore: this._balance, balanceAfter };
    this._balance = balanceAfter;
    this._version += 1;
    this._appliedTransactions.add(transactionId);
    this._entries.push(entry);
    return entry;
  }
}

/** Rebuilds a balance from ledger entries; used by reconciliation and by test invariants. */
export function balanceFromLedger(currency: string, entries: readonly Pick<LedgerEntryDraft, 'direction' | 'amount'>[]): Money {
  let minor = 0n;
  for (const e of entries) {
    minor += e.direction === 'CREDIT' ? e.amount.minor : -e.amount.minor;
  }
  return Money.fromMinor(minor, currency);
}
