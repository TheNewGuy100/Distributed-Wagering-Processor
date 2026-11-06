import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../domain/events';
import { Wallet } from '../../domain/wallet';
import { enqueueEvent } from '../../infrastructure/outbox/outbox-writer';
import {
  LedgerEntry,
  WagerTransaction,
  Wallet as WalletSchema,
  type WalletEntity,
} from '../../infrastructure/persistence/entities';
import { insertIgnoringConflict } from '../../infrastructure/persistence/orm-helpers';
import { persistWalletChanges } from '../../infrastructure/persistence/wallet-repository';
import { ValidationError, WalletAlreadyExistsError, WalletNotFoundError } from '../errors';
import { asObject, assertUuid, currencyField, moneyField, requiredString } from '../validation';

export interface WalletView {
  walletId: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: string;
  /** Set when a reconciliation found a divergence; informational, never auto-cleared. */
  flaggedAt: string | null;
}

export interface LedgerEntryView {
  entryId: string;
  transactionId: string;
  direction: string;
  amount: string;
  balanceAfter: string;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

const toView = (w: WalletEntity): WalletView => ({
  walletId: w.id,
  playerId: w.playerId,
  currency: w.currency,
  balance: w.balance,
  version: Number(w.version),
  createdAt: new Date(w.createdAt).toISOString(),
  flaggedAt: w.flaggedAt ? new Date(w.flaggedAt).toISOString() : null,
});

export const encodeCursor = (seq: string | number | bigint): string =>
  Buffer.from(JSON.stringify({ s: String(seq) })).toString('base64url');

export function decodeCursor(cursor: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown };
    if (typeof parsed.s === 'string' && /^\d{1,18}$/.test(parsed.s)) return parsed.s;
  } catch {
    // fall through
  }
  throw new ValidationError('invalid cursor');
}

@Injectable()
export class WalletService {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async create(body: unknown): Promise<WalletView> {
    const o = asObject(body);
    const playerId = requiredString(o, 'playerId');
    const currency = currencyField(o);
    const opening =
      o.openingCredit === undefined || o.openingCredit === null
        ? null
        : moneyField(o.openingCredit, currency, 'openingCredit');

    return this.em.fork().transactional(async (tx) => {
      const walletId = randomUUID();
      // One wallet per player and currency: the unique constraint decides, a duplicate inserts nothing.
      const inserted = await insertIgnoringConflict(
        tx,
        WalletSchema,
        { id: walletId, playerId, currency },
        'id',
        ['playerId', 'currency'],
      );
      if (!inserted) throw new WalletAlreadyExistsError();

      if (opening && !opening.isZero()) {
        const txId = randomUUID();
        const externalId = `opening:${walletId}`;
        await tx.insert(WagerTransaction, {
          id: txId,
          providerId: 'internal',
          externalTransactionId: externalId,
          idempotencyKey: `internal:${externalId}`,
          payloadHash: createHash('sha256').update(`${walletId}:${opening.toString()}`).digest('hex'),
          kind: 'OPENING',
          status: 'PROCESSED',
          playerId,
          currency,
          amount: opening.toString(),
          wallet: walletId,
        });
        const wallet = Wallet.open(walletId, playerId, currency);
        const entry = wallet.credit(txId, opening);
        await persistWalletChanges(tx, wallet, 0, [entry]);
        await enqueueEvent(
          tx,
          new WagerTransactionProcessed(txId, {
            transactionId: txId,
            providerId: 'internal',
            externalTransactionId: externalId,
            kind: 'OPENING',
            walletId,
            amount: opening.toString(),
            currency,
          }),
        );
        await enqueueEvent(
          tx,
          new WalletBalanceChanged(walletId, {
            walletId,
            transactionId: txId,
            direction: 'CREDIT',
            amount: opening.toString(),
            balanceAfter: entry.balanceAfter.toString(),
            currency,
            walletVersion: wallet.version,
          }),
        );
      }
      return this.load(tx, walletId);
    });
  }

  get(walletId: string): Promise<WalletView> {
    assertUuid(walletId, 'walletId');
    return this.load(this.em.fork(), walletId);
  }

  async ledger(walletId: string, cursor: string | undefined, limitRaw: string | undefined): Promise<LedgerPage> {
    assertUuid(walletId, 'walletId');
    let limit = 50;
    if (limitRaw !== undefined) {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ValidationError('limit must be 1-200');
    }
    const after = cursor === undefined ? '0' : decodeCursor(cursor);
    const em = this.em.fork();
    await this.load(em, walletId); // 404 when the wallet does not exist

    // Ordered by the insert-order sequence, so pages are stable even while new entries are appended.
    const rows = await em.find(
      LedgerEntry,
      { wallet: walletId, seq: { $gt: after } },
      { orderBy: { seq: 'asc' }, limit: limit + 1 },
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        entryId: r.id,
        transactionId: r.transaction,
        direction: r.direction,
        amount: r.amount,
        balanceAfter: r.balanceAfter,
        createdAt: new Date(r.createdAt).toISOString(),
      })),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!.seq) : null,
    };
  }

  private async load(em: EntityManager, walletId: string): Promise<WalletView> {
    const w = await em.findOne(WalletSchema, { id: walletId }, { refresh: true });
    if (!w) throw new WalletNotFoundError();
    return toView(w);
  }
}
