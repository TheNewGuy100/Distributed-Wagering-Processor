import { defaultIdempotencyKey, payloadHash } from '../../domain/idempotency';
import type { Money } from '../../domain/money';
import type { TransactionKind } from '../../domain/wager-rules';
import { ValidationError } from '../errors';
import {
  asObject,
  assertUuid,
  moneyProps,
  optionalString,
  requiredString,
} from '../validation';

export const EXTERNAL_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;

export interface ProcessWagerCommand {
  providerId: string;
  externalTransactionId: string;
  kind: TransactionKind;
  playerId: string;
  walletId: string;
  currency: string;
  amount: Money;
  roundId: string | null;
  /** Which game the round belongs to. Required for BET, WIN and LOSS; reversals inherit it from their reference. */
  gameId: string | null;
  referenceExternalId: string | null;
  idempotencyKey: string;
  payloadHash: string;
}

/**
 * Validates an untrusted request body (HTTP, or the `data` of a queue message) into a command.
 * The `Idempotency-Key` is mandatory and is the source of truth for deduplication.
 */
export function parseWagerCommand(body: unknown, idempotencyKey: string | undefined | null): ProcessWagerCommand {
  if (idempotencyKey === undefined || idempotencyKey === null || idempotencyKey.trim() === '') {
    throw new ValidationError('Idempotency-Key is required');
  }
  if (idempotencyKey.length > 255) throw new ValidationError('Idempotency-Key must be 1-255 characters');

  const o = asObject(body);
  const providerId = requiredString(o, 'providerId');
  const externalTransactionId = requiredString(o, 'externalTransactionId', 255);
  const kind = requiredString(o, 'kind', 16);
  if (!(EXTERNAL_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError(`kind must be one of ${EXTERNAL_KINDS.join(', ')}`);
  }
  const playerId = requiredString(o, 'playerId');
  const walletId = assertUuid(requiredString(o, 'walletId'), 'walletId');
  const amount = moneyProps(o.money, 'money');
  const currency = amount.currency;
  const roundId = optionalString(o, 'roundId');
  const gameId = optionalString(o, 'gameId');
  const referenceExternalId = optionalString(o, 'referenceExternalTransactionId', 255);

  const isReversal = kind === 'REFUND' || kind === 'ROLLBACK';
  if (isReversal && referenceExternalId === null) {
    throw new ValidationError(`referenceExternalTransactionId is required for ${kind}`);
  }
  if (!isReversal && referenceExternalId !== null) {
    throw new ValidationError('referenceExternalTransactionId is only allowed for REFUND and ROLLBACK');
  }
  if (!isReversal && gameId === null) throw new ValidationError(`gameId is required for ${kind}`);
  if (referenceExternalId === externalTransactionId) {
    throw new ValidationError('a transaction cannot reference itself');
  }

  return {
    providerId,
    externalTransactionId,
    kind: kind as TransactionKind,
    playerId,
    walletId,
    currency,
    amount,
    roundId,
    gameId,
    referenceExternalId,
    idempotencyKey,
    // Business fields only: the Idempotency-Key header and transport metadata are not part of the hash.
    payloadHash: payloadHash({
      providerId,
      externalTransactionId,
      kind,
      playerId,
      walletId,
      money: { amount: amount.toString(), currency },
      roundId,
      gameId,
      referenceExternalTransactionId: referenceExternalId,
    }),
  };
}

export { defaultIdempotencyKey };
