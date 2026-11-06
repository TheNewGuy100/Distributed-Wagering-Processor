import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module';
import { JsonLogger } from '../../src/infrastructure/observability/json-logger';
import config from '../../src/infrastructure/persistence/mikro-orm.config';

export interface TestApp {
  url: string;
  app: INestApplication;
  orm: MikroORM;
  close(): Promise<void>;
}

export async function bootApp(env: Record<string, string> = {}): Promise<TestApp> {
  // HTTP-only tests keep the consumer off; SQS tests turn it on and pick their own queues.
  process.env.SQS_CONSUMER_ENABLED = 'false';
  process.env.OUTBOX_ENABLED = 'false';
  process.env.PENDING_WORKER_ENABLED = 'false';
  process.env.ORM_QUERY_LOG = 'false';
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const orm = await MikroORM.init(config);
  await orm.migrator.up(); // idempotent
  // Expected error/warn logs (simulated crashes, deliberate corruption) must not look like failures in
  // the test report. Tests that care assert on logs explicitly; set TEST_LOG_LEVEL=error to see them all.
  const app = await NestFactory.create(AppModule, { logger: new JsonLogger(process.env.TEST_LOG_LEVEL ?? 'silent') });
  await app.listen(0);
  const url = await app.getUrl();
  return {
    url: url.replace('[::1]', 'localhost'),
    app,
    orm,
    close: async () => {
      await app.close();
      await orm.close();
    },
  };
}

export const uid = (p = 'x') => `${p}-${randomUUID().slice(0, 8)}`;

export async function api(t: TestApp, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${t.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export async function createWallet(t: TestApp, opening?: string, currency = 'BRL') {
  const playerId = uid('player');
  const r = await api(t, 'POST', '/wallets', { playerId, currency, ...(opening ? { openingCredit: opening } : {}) });
  if (r.status !== 201) throw new Error(`wallet creation failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { playerId, walletId: r.body.walletId as string, currency };
}

export const wager = (
  t: TestApp,
  w: { playerId: string; currency: string },
  over: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) =>
  api(
    t,
    'POST',
    '/wagering/transactions',
    {
      providerId: 'prov-a',
      externalTransactionId: uid('ext'),
      kind: 'BET',
      playerId: w.playerId,
      currency: w.currency,
      amount: '10.00',
      roundId: 'round-1',
      ...over,
    },
    headers,
  );

/** Final invariant used by every test: stored balance == balance rebuilt from the ledger. */
export async function expectLedgerConsistent(t: TestApp, walletId: string) {
  const em = t.orm.em.fork();
  const [w] = await em.execute<{ balance: string }[]>('select balance from wallets where id = ?', [walletId]);
  const [l] = await em.execute<{ rebuilt: string; entries: number }[]>(
    `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(18,2) as rebuilt,
            count(*)::int as entries
       from ledger_entries where wallet_id = ?`,
    [walletId],
  );
  if (w!.balance !== l!.rebuilt) throw new Error(`ledger divergence: balance=${w!.balance} rebuilt=${l!.rebuilt}`);
  return { balance: w!.balance, entries: l!.entries };
}
