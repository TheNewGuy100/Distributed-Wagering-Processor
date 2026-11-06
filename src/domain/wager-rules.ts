import { FailureCode } from './errors';
import type { Money } from './money';
import type { LedgerDirection, LedgerEntryDraft, Wallet } from './wallet';

export type TransactionKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK' | 'OPENING';
export type TransactionStatus = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';

export const REVERSAL_KINDS: readonly TransactionKind[] = ['REFUND', 'ROLLBACK'];

export interface TransactionInput {
  kind: TransactionKind;
  providerId: string;
  playerId: string;
  currency: string;
  amount: Money;
  roundId: string | null;
  /** External id (same provider) of the transaction being reversed; REFUND/ROLLBACK only. */
  referenceExternalId: string | null;
}

/** What the rules need to know about the referenced transaction (already loaded and locked). */
export interface ReferenceSnapshot {
  id: string;
  providerId: string;
  playerId: string;
  walletId: string;
  currency: string;
  roundId: string | null;
  gameId?: string | null;
  kind: TransactionKind;
  status: TransactionStatus;
  amount: Money;
  /** Kinds of already PROCESSED reversals pointing at this transaction. */
  reversedBy: readonly TransactionKind[];
}

export type Decision =
  | { type: 'APPLY'; direction: LedgerDirection; amount: Money }
  | { type: 'NO_BALANCE_EFFECT' }
  | { type: 'REJECT'; code: FailureCode; detail?: string }
  | { type: 'PENDING_REFERENCE' };

const reject = (code: FailureCode, detail?: string): Decision =>
  detail === undefined ? { type: 'REJECT', code } : { type: 'REJECT', code, detail };

/**
 * Pure business decision for a transaction against a wallet (and, for reversals, its
 * reference). Performs no mutation; use {@link applyDecision} to execute it.
 */
export function decide(input: TransactionInput, wallet: Wallet, reference: ReferenceSnapshot | null): Decision {
  if (input.playerId !== wallet.playerId) return reject(FailureCode.WalletPlayerMismatch);
  if (input.currency !== wallet.currency || input.amount.currency !== wallet.currency) {
    return reject(FailureCode.CurrencyMismatch);
  }

  switch (input.kind) {
    case 'BET':
      if (input.amount.isZero()) return reject(FailureCode.InvalidAmount);
      return wallet.canDebit(input.amount)
        ? { type: 'APPLY', direction: 'DEBIT', amount: input.amount }
        : reject(FailureCode.InsufficientFunds);

    case 'WIN':
    case 'OPENING':
      if (input.amount.isZero()) return reject(FailureCode.InvalidAmount);
      return { type: 'APPLY', direction: 'CREDIT', amount: input.amount };

    case 'LOSS':
      // The stake was already debited by the BET; a loss only closes the round.
      return { type: 'NO_BALANCE_EFFECT' };

    case 'REFUND':
    case 'ROLLBACK':
      return decideReversal(input, wallet, reference);
  }
}

function decideReversal(input: TransactionInput, wallet: Wallet, ref: ReferenceSnapshot | null): Decision {
  if (ref === null) return { type: 'PENDING_REFERENCE' };
  if (ref.status === 'PENDING' || ref.status === 'PENDING_REFERENCE') return { type: 'PENDING_REFERENCE' };
  if (ref.status !== 'PROCESSED') return reject(FailureCode.ReferenceNotProcessed);

  if (ref.providerId !== input.providerId) return reject(FailureCode.ReferenceMismatch, 'provider');
  if (ref.playerId !== input.playerId) return reject(FailureCode.ReferenceMismatch, 'player');
  if (ref.walletId !== wallet.id) return reject(FailureCode.ReferenceMismatch, 'wallet');
  if (ref.currency !== input.currency) return reject(FailureCode.ReferenceMismatch, 'currency');
  if (ref.roundId !== input.roundId) return reject(FailureCode.ReferenceMismatch, 'round');
  if (!ref.amount.equals(input.amount)) return reject(FailureCode.ReferenceMismatch, 'amount');

  // Only money-moving BET/WIN can be reversed. LOSS moved nothing; reversals and OPENING are final.
  if (ref.kind !== 'BET' && ref.kind !== 'WIN') return reject(FailureCode.ReferenceNotReversible);

  // Stricter than "once per operation type": a REFUND after a ROLLBACK (or vice versa) would
  // return the same money twice, so any prior reversal blocks the next one.
  if (ref.reversedBy.length > 0) return reject(FailureCode.AlreadyReversed);

  if (ref.kind === 'BET') return { type: 'APPLY', direction: 'CREDIT', amount: ref.amount };
  return wallet.canDebit(ref.amount)
    ? { type: 'APPLY', direction: 'DEBIT', amount: ref.amount }
    : reject(FailureCode.ReversalWouldOverdraw);
}

/** Executes an APPLY decision on the wallet; returns the ledger entry, or null when none is due. */
export function applyDecision(wallet: Wallet, transactionId: string, decision: Decision): LedgerEntryDraft | null {
  if (decision.type !== 'APPLY') return null;
  return decision.direction === 'CREDIT'
    ? wallet.credit(transactionId, decision.amount)
    : wallet.debit(transactionId, decision.amount);
}
