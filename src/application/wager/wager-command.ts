import { defaultIdempotencyKey, payloadHash } from '../../domain/idempotency';
import type { Money } from '../../domain/money';
import type { TransactionKind } from '../../domain/wager-rules';
import { ValidationError } from '../errors';
import { asObject, currencyField, moneyField, optionalString, requiredString } from '../validation';

export const EXTERNAL_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;

export interface ProcessWagerCommand {
  providerId: string;
  externalTransactionId: string;
  kind: TransactionKind;
  playerId: string;
  currency: string;
  amount: Money;
  roundId: string | null;
  referenceExternalId: string | null;
  idempotencyKey: string;
  payloadHash: string;
}

/** Validates an untrusted request body (HTTP or queue message) into a command. */
export function parseWagerCommand(body: unknown, idempotencyKeyHeader?: string | null): ProcessWagerCommand {
  const o = asObject(body);
  const providerId = requiredString(o, 'providerId');
  const externalTransactionId = requiredString(o, 'externalTransactionId', 255);
  const kind = requiredString(o, 'kind', 16);
  if (!(EXTERNAL_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError(`kind must be one of ${EXTERNAL_KINDS.join(', ')}`);
  }
  const playerId = requiredString(o, 'playerId');
  const currency = currencyField(o);
  const amount = moneyField(o.amount, currency, 'amount');
  const roundId = optionalString(o, 'roundId');
  const referenceExternalId = optionalString(o, 'referenceExternalId', 255);

  const isReversal = kind === 'REFUND' || kind === 'ROLLBACK';
  if (isReversal && referenceExternalId === null) {
    throw new ValidationError(`referenceExternalId is required for ${kind}`);
  }
  if (!isReversal && referenceExternalId !== null) {
    throw new ValidationError('referenceExternalId is only allowed for REFUND and ROLLBACK');
  }
  if (referenceExternalId === externalTransactionId) {
    throw new ValidationError('a transaction cannot reference itself');
  }

  let idempotencyKey = defaultIdempotencyKey(providerId, externalTransactionId);
  if (idempotencyKeyHeader !== undefined && idempotencyKeyHeader !== null) {
    if (idempotencyKeyHeader.trim() === '' || idempotencyKeyHeader.length > 255) {
      throw new ValidationError('Idempotency-Key must be 1-255 characters');
    }
    idempotencyKey = idempotencyKeyHeader;
  }

  return {
    providerId,
    externalTransactionId,
    kind: kind as TransactionKind,
    playerId,
    currency,
    amount,
    roundId,
    referenceExternalId,
    idempotencyKey,
    payloadHash: payloadHash({
      providerId,
      externalTransactionId,
      kind,
      playerId,
      currency,
      amount: amount.toString(),
      roundId,
      referenceExternalId,
    }),
  };
}
