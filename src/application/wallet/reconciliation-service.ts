import { EntityManager, raw } from '@mikro-orm/postgresql';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '../../infrastructure/observability/metrics.service';
import { Wallet } from '../../infrastructure/persistence/entities';
import { WalletNotFoundError } from '../errors';
import { assertUuid } from '../validation';

export interface ReconciliationReport {
  walletId: string;
  currency: string;
  storedBalance: string;
  calculatedBalance: string;
  storedVersion: number;
  ledgerEntries: number;
  divergent: boolean;
  /** What exactly disagrees; empty when consistent. */
  differences: string[];
  flaggedAt: string | null;
  checkedAt: string;
}

/**
 * Compares the stored balance with the one rebuilt from the append-only ledger.
 * A divergence is logged, counted and flagged on the wallet — never silently "fixed":
 * deciding which side is right is a human/audit decision.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {
    this.metrics.describe('wallet_reconciliations_total', 'Reconciliation runs by result');
    this.metrics.describe('wallet_reconciliation_divergences_total', 'Reconciliations that found a divergence');
  }

  async reconcile(walletId: string): Promise<ReconciliationReport> {
    assertUuid(walletId, 'walletId');
    const em = this.em.fork();

    // One statement = one snapshot, so concurrent traffic cannot make a healthy wallet look divergent. This is the
    // one deliberate raw query: a grouped aggregate over the ledger joined to the wallet has no ORM equivalent that
    // keeps the single-snapshot guarantee.
    const rows = await em.execute<
      {
        currency: string;
        stored: string;
        calculated: string;
        version: string | number;
        entries: number;
        last_balance_after: string | null;
        flagged_at: string | null;
      }[]
    >(
      `select w.currency, w.balance as stored, w.version, w.flagged_at,
              coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(18,2) as calculated,
              count(l.id)::int as entries,
              (array_agg(l.balance_after order by l.seq desc))[1] as last_balance_after
         from wallets w left join ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    const r = rows[0];
    if (!r) throw new WalletNotFoundError();

    const differences: string[] = [];
    if (r.stored !== r.calculated) {
      differences.push(`stored balance ${r.stored} != ledger-derived balance ${r.calculated}`);
    }
    if (Number(r.version) !== r.entries) {
      differences.push(`wallet version ${r.version} != ledger entries ${r.entries}`);
    }
    if (r.last_balance_after !== null && r.last_balance_after !== r.stored) {
      differences.push(`last ledger balance_after ${r.last_balance_after} != stored balance ${r.stored}`);
    }
    const divergent = differences.length > 0;

    let flaggedAt = r.flagged_at === null ? null : new Date(r.flagged_at).toISOString();
    this.metrics.inc('wallet_reconciliations_total', { result: divergent ? 'divergent' : 'ok' });
    if (divergent) {
      this.metrics.inc('wallet_reconciliation_divergences_total');
      this.logger.error(
        JSON.stringify({ event: 'reconciliation_divergence', walletId, differences }),
      );
      // coalesce keeps the time of the FIRST flag; the reason is refreshed on every divergent run.
      await em.nativeUpdate(
        Wallet,
        { id: walletId },
        { flaggedAt: raw('coalesce(flagged_at, now())') as never, flagReason: differences.join('; ').slice(0, 1000) },
      );
      const flagged = await em.findOne(Wallet, { id: walletId }, { refresh: true });
      flaggedAt = flagged?.flaggedAt ? new Date(flagged.flaggedAt).toISOString() : flaggedAt;
    }

    return {
      walletId,
      currency: r.currency,
      storedBalance: r.stored,
      calculatedBalance: r.calculated,
      storedVersion: Number(r.version),
      ledgerEntries: r.entries,
      divergent,
      differences,
      flaggedAt,
      checkedAt: new Date().toISOString(),
    };
  }
}
