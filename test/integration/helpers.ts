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

/**
 * Integration tests share the database with anything else that runs the application: a second consumer, outbox
 * publisher or retry worker (the docker-compose `app` container, `bun run start`) would race the tests for their
 * rows and queues, and fail them in confusing ways. Fail early with the fix instead.
 */
let stackChecked: Promise<void> | undefined;
function assertNoStackRunning(): Promise<void> {
  stackChecked ??= (async () => {
    try {
      const res = await fetch('http://localhost:3000/health/live', { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        throw new Error(
          'An application instance answers on http://localhost:3000 (the docker-compose `app` container or ' +
            '`bun run start`). Stop it before running the integration tests: `bun run stack:down` or `docker compose stop app`.',
        );
      }
    } catch (e) {
      if ((e as Error).message.startsWith('An application instance')) throw e;
      // nothing listening: good
    }
  })();
  return stackChecked;
}

export async function bootApp(env: Record<string, string> = {}): Promise<TestApp> {
  await assertNoStackRunning();
  // HTTP-only tests keep the consumer off; SQS tests turn it on and pick their own queues.
  process.env.SQS_CONSUMER_ENABLED = 'false';
  process.env.OUTBOX_ENABLED = 'false';
  process.env.PENDING_WORKER_ENABLED = 'false';
  process.env.ORM_QUERY_LOG = 'false';
  // Authentication settings must not leak from one test file's app to the next one's.
  for (const k of Object.keys(process.env)) if (k.startsWith('AUTH_')) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const orm = await MikroORM.init(config);
  await orm.migrator.up(); // idempotent
  // Expected error/warn logs (simulated crashes, deliberate corruption) must not look like failures in
  // the test report. Tests that care assert on logs explicitly; set TEST_LOG_LEVEL=error to see them all.
  let app;
  try {
    app = await NestFactory.create(AppModule, {
      logger: new JsonLogger(process.env.TEST_LOG_LEVEL ?? 'silent'),
      abortOnError: false, // a failing start-up must reject (testable), not kill the test runner
    });
    await app.listen(0);
  } catch (e) {
    await orm.close(); // a rejected start-up must not leave a connection pool behind
    throw e;
  } finally {
    // The settings were read while the app was created; leaving them in process.env would leak them into whatever
    // runs next in this process (another app, or a child process that inherits the environment).
    for (const k of Object.keys(process.env)) if (k.startsWith('AUTH_')) delete process.env[k];
  }
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
  const r = await api(t, 'POST', '/wallets', {
    playerId,
    initialBalance: { amount: opening ?? '0.00', currency },
  });
  if (r.status !== 201) throw new Error(`wallet creation failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { playerId, walletId: r.body.id as string, currency };
}

/**
 * Builds a wager payload in the wire format of the challenge. `over` may set the flat shortcuts `amount` and
 * `currency` (turned into `money`) next to any other field; `Idempotency-Key` defaults to provider:externalId.
 */
export function wagerBody(
  w: { playerId: string; walletId: string; currency: string },
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const { amount, currency, ...rest } = over as { amount?: string; currency?: string };
  const body: Record<string, unknown> = {
    providerId: 'prov-a',
    externalTransactionId: uid('ext'),
    kind: 'BET',
    playerId: w.playerId,
    walletId: w.walletId,
    money: { amount: amount ?? '10.00', currency: currency ?? w.currency },
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    ...rest,
  };
  if (body.kind === 'REFUND' || body.kind === 'ROLLBACK') delete body.gameId;
  return body;
}

export const wager = (
  t: TestApp,
  w: { playerId: string; walletId: string; currency: string },
  over: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) => {
  const body = wagerBody(w, over);
  return api(t, 'POST', '/wagering/transactions', body, {
    'idempotency-key': `${body.providerId}:${body.externalTransactionId}`,
    ...headers,
  });
};

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
