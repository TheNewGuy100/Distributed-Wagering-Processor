import { randomUUID } from 'node:crypto';
import type { Money } from './money';

/** Envelope shared by all domain events. Money is always serialized as a decimal string. */
export abstract class DomainEvent<TData extends Record<string, unknown> = Record<string, unknown>> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  constructor(
    readonly aggregateId: string,
    readonly data: TData,
    readonly eventId: string = randomUUID(),
    readonly occurredAt: Date = new Date(),
  ) {}

  /**
   * `correlationId` ties every event of one request/message together; `causationId` is what directly caused this
   * event (the queue message when there is one, otherwise the transaction).
   */
  toEnvelope(ctx: { correlationId: string; causationId?: string }) {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateId: this.aggregateId,
      correlationId: ctx.correlationId,
      ...(ctx.causationId ? { causationId: ctx.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      data: this.data,
    };
  }
}

/** Decimal string + currency; never a number. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

interface TxData extends Record<string, unknown> {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
  walletId: string | null;
  roundId: string | null;
  gameId: string | null;
  money: MoneyProps;
}

export class WagerTransactionProcessed extends DomainEvent<TxData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
}

export class WagerTransactionRejected extends DomainEvent<TxData & { failureCode: string }> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
}

export class WagerTransactionPendingReference extends DomainEvent<TxData & { referenceExternalId: string | null }> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
}

/** Emitted only when the balance actually changes. */
export class WalletBalanceChanged extends DomainEvent<{
  walletId: string;
  transactionId: string;
  direction: 'CREDIT' | 'DEBIT';
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
}

export const money = (m: Money): string => m.toString();
