import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../domain/events';
import { Wallet } from '../../domain/wallet';
import { enqueueEvent } from '../../infrastructure/outbox/outbox-writer';
import {
  persistWalletChanges,
  walletFromRow,
  type WalletRow,
} from '../../infrastructure/persistence/wallet-sql';
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

const toView = (r: WalletRow & { flagged_at?: string | null }): WalletView => ({
  walletId: r.id,
  playerId: r.player_id,
  currency: r.currency,
  balance: r.balance,
  version: Number(r.version),
  createdAt: new Date(r.created_at).toISOString(),
  flaggedAt: r.flagged_at ? new Date(r.flagged_at).toISOString() : null,
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
      const inserted = await tx.execute<{ id: string }[]>(
        `insert into wallets (id, player_id, currency) values (?, ?, ?)
         on conflict (player_id, currency) do nothing returning id`,
        [walletId, playerId, currency],
      );
      if (inserted.length === 0) throw new WalletAlreadyExistsError();

      if (opening && !opening.isZero()) {
        const txId = randomUUID();
        const externalId = `opening:${walletId}`;
        await tx.execute(
          `insert into wager_transactions
             (id, provider_id, external_transaction_id, idempotency_key, payload_hash, kind, status,
              player_id, currency, amount, wallet_id)
           values (?, 'internal', ?, ?, ?, 'OPENING', 'PROCESSED', ?, ?, ?, ?)`,
          [
            txId,
            externalId,
            `internal:${externalId}`,
            createHash('sha256').update(`${walletId}:${opening.toString()}`).digest('hex'),
            playerId,
            currency,
            opening.toString(),
            walletId,
          ],
        );
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

    const rows = await em.execute<
      {
        seq: string;
        id: string;
        transaction_id: string;
        direction: string;
        amount: string;
        balance_after: string;
        created_at: string;
      }[]
    >(
      `select seq, id, transaction_id, direction, amount, balance_after, created_at
         from ledger_entries where wallet_id = ? and seq > ? order by seq asc limit ?`,
      [walletId, after, limit + 1],
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        entryId: r.id,
        transactionId: r.transaction_id,
        direction: r.direction,
        amount: r.amount,
        balanceAfter: r.balance_after,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!.seq) : null,
    };
  }

  private async load(em: EntityManager, walletId: string): Promise<WalletView> {
    const rows = await em.execute<(WalletRow & { flagged_at: string | null })[]>(
      'select id, player_id, currency, balance, version, created_at, flagged_at from wallets where id = ?',
      [walletId],
    );
    if (!rows[0]) throw new WalletNotFoundError();
    return toView(rows[0]);
  }
}

export { walletFromRow };
