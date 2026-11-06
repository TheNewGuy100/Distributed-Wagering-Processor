/** Application-level errors; the HTTP exception filter maps each to a status code. */
export class ApplicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends ApplicationError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message);
  }
}

export class IdempotencyConflictError extends ApplicationError {
  constructor(message = 'idempotency key or external transaction id already used with a different payload') {
    super('IDEMPOTENCY_CONFLICT', message);
  }
}

export class WalletNotFoundError extends ApplicationError {
  constructor(message = 'wallet not found') {
    super('WALLET_NOT_FOUND', message);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  constructor() {
    super('TRANSACTION_NOT_FOUND', 'transaction not found');
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  constructor() {
    super('WALLET_ALREADY_EXISTS', 'a wallet already exists for this player and currency');
  }
}
