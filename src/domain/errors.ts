/** Stable, machine-readable codes persisted as `failure_code` and exposed in API/events. */
export const FailureCode = {
  InvalidAmount: 'INVALID_AMOUNT',
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  WalletPlayerMismatch: 'WALLET_PLAYER_MISMATCH',
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw: 'REVERSAL_WOULD_OVERDRAW',
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  ReferenceMismatch: 'REFERENCE_MISMATCH',
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED',
  ReferenceNotReversible: 'REFERENCE_NOT_REVERSIBLE',
  AlreadyReversed: 'ALREADY_REVERSED',
} as const;
export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super('INVALID_MONEY', message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super(FailureCode.CurrencyMismatch, `currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super(FailureCode.InsufficientFunds, 'insufficient funds');
  }
}

export class InvariantViolationError extends DomainError {
  constructor(message: string) {
    super('INVARIANT_VIOLATION', message);
  }
}
