/**
 * Load test: `bun run test:load`
 *
 * Boots N application instances (sharing the PostgreSQL and SQS from docker compose), drives them over real HTTP
 * with a realistic mix, then verifies the financial invariant on every wallet.
 * By default each instance is its OWN process (`bun src/main.ts`), like the compose services: the load generator then
 * does not share an event loop with the application. LOAD_MODE=inprocess boots them inside this process instead (the
 * mode earlier measurements in the docs were taken with).
 * Knobs (env): LOAD_DURATION_SECONDS=15 LOAD_CONCURRENCY=64 LOAD_WALLETS=50 LOAD_INSTANCES=2 LOAD_HOT_SHARE=0.2
 *              LOAD_MODE=processes|inprocess  LOAD_BASE_PORT=3100
 */
import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';

const num = (k: string, d: number) => (process.env[k] === undefined ? d : Number(process.env[k]));
const DURATION_S = num('LOAD_DURATION_SECONDS', 15);
const CONCURRENCY = num('LOAD_CONCURRENCY', 64);
const WALLETS = num('LOAD_WALLETS', 50);
const INSTANCES = num('LOAD_INSTANCES', 2);
const HOT_SHARE = num('LOAD_HOT_SHARE', 0.2); // share of traffic aimed at the two hottest wallets
const MODE = process.env.LOAD_MODE === 'inprocess' ? 'inprocess' : 'processes';
const BASE_PORT = num('LOAD_BASE_PORT', 3100);

const suffix = Date.now().toString(36);
Object.assign(process.env, {
  SQS_QUEUE_NAME: `load-wagers-${suffix}.fifo`,
  SQS_DLQ_NAME: `load-dlq-${suffix}.fifo`,
  SQS_EVENTS_QUEUE_NAME: `load-events-${suffix}.fifo`,
  SQS_CONSUMER_ENABLED: 'false', // the load goes through HTTP; the consumer shares the same use case
  OUTBOX_ENABLED: 'true',
  PENDING_WORKER_ENABLED: 'true',
});

const { default: ormConfig } = await import('../src/infrastructure/persistence/mikro-orm.config');

interface Instance {
  /** Stops the instance (gracefully: the publisher gets to finish its cycle). */
  stop(): Promise<void>;
  url: string;
}

const orm = await MikroORM.init(ormConfig);
await orm.migrator.up();

const instances: Instance[] = [];

async function startInProcess(): Promise<Instance> {
  const { AppModule } = await import('../src/app.module');
  const app: INestApplication = await NestFactory.create(AppModule, { logger: ['error'] });
  await app.listen(0);
  return { url: (await app.getUrl()).replace('[::1]', 'localhost'), stop: () => app.close() };
}

async function startProcess(port: number): Promise<Instance> {
  const child = Bun.spawn([process.execPath, 'src/main.ts'], {
    env: { ...process.env, PORT: String(port), LOG_LEVEL: 'error' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.on('exit', () => child.kill()); // never leave an instance behind, whatever way the script ends
  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`instance on port ${port} exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${url}/health/ready`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`instance on port ${port} did not become ready`);
    }
    await Bun.sleep(200);
  }
  return {
    url,
    stop: async () => {
      // Graceful where signals exist (src/main.ts enables shutdown hooks); on Windows kill() terminates the process.
      if (process.platform === 'win32') child.kill();
      else child.kill('SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const forced = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 15_000);
      });
      await Promise.race([child.exited, forced]);
      clearTimeout(timer);
    },
  };
}

try {
  for (let i = 0; i < INSTANCES; i++) instances.push(MODE === 'processes' ? await startProcess(BASE_PORT + i) : await startInProcess());
} catch (e) {
  for (const inst of instances) await inst.stop();
  throw e;
}
let rr = 0;
const nextUrl = () => instances[rr++ % instances.length]!.url;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${nextUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function scrape(): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  for (const inst of instances) {
    const text = await (await fetch(`${inst.url}/metrics`)).text();
    for (const line of text.split('\n')) {
      if (line.startsWith('#') || !line.trim()) continue;
      const idx = line.lastIndexOf(' ');
      const name = line.slice(0, idx);
      totals.set(name, (totals.get(name) ?? 0) + Number(line.slice(idx + 1)));
    }
  }
  return totals;
}
const sumMetric = (m: Map<string, number>, prefix: string) =>
  [...m.entries()].filter(([k]) => k === prefix || k.startsWith(`${prefix}{`)).reduce((s, [, v]) => s + v, 0);

// ---- setup ----------------------------------------------------------------------------------
console.log(`Setting up ${WALLETS} wallets...`);
const wallets: { playerId: string; walletId: string }[] = [];
for (let i = 0; i < WALLETS; i++) {
  const playerId = `load-${suffix}-${i}`;
  const r = await post('/wallets', { playerId, initialBalance: { amount: '1000000.00', currency: 'BRL' } });
  if (r.status !== 201) throw new Error(`wallet setup failed: ${r.status}`);
  wallets.push({ playerId, walletId: r.json!.id as string });
}
const before = await scrape();

// ---- load -----------------------------------------------------------------------------------
const latencies: number[] = [];
const statusCounts = new Map<string, number>();
let errors = 0;
let sent = 0;
const recent: { body: Record<string, unknown> }[] = [];
let maxOutboxLag = 0;

const pickWallet = () => {
  if (Math.random() < HOT_SHARE) return wallets[Math.floor(Math.random() * Math.min(2, wallets.length))]!;
  return wallets[Math.floor(Math.random() * wallets.length)]!;
};
const cents = () => `${1 + Math.floor(Math.random() * 20)}.${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;

async function oneRequest(): Promise<void> {
  const roll = Math.random();
  let body: Record<string, unknown>;
  if (roll < 0.05 && recent.length > 0) {
    body = recent[Math.floor(Math.random() * recent.length)]!.body; // exact replay (duplicate delivery)
  } else {
    const w = pickWallet();
    const kind = roll < 0.65 ? 'BET' : roll < 0.9 ? 'WIN' : 'LOSS';
    body = {
      providerId: 'load-provider',
      externalTransactionId: randomUUID(),
      kind,
      playerId: w.playerId,
      walletId: w.walletId,
      money: { amount: cents(), currency: 'BRL' },
      roundId: `round-${Math.floor(Math.random() * 1000)}`,
      gameId: `game-${Math.floor(Math.random() * 5)}`,
    };
    recent.push({ body });
    if (recent.length > 500) recent.shift();
  }
  const t0 = performance.now();
  try {
    const r = await post('/wagering/transactions', body, {
      'idempotency-key': `${body.providerId}:${body.externalTransactionId}`,
    });
    latencies.push(performance.now() - t0);
    statusCounts.set(String(r.status), (statusCounts.get(String(r.status)) ?? 0) + 1);
    if (r.status >= 500 || ![200, 201, 202, 422].includes(r.status)) errors++;
  } catch {
    latencies.push(performance.now() - t0);
    errors++;
    statusCounts.set('network-error', (statusCounts.get('network-error') ?? 0) + 1);
  }
  sent++;
}

console.log(`Running ${DURATION_S}s at concurrency ${CONCURRENCY} across ${INSTANCES} instance(s)...`);
const startedAt = performance.now();
const stopAt = startedAt + DURATION_S * 1000;
const sampler = setInterval(async () => {
  try {
    const lag = (await scrape()).get('outbox_lag_seconds') ?? 0;
    maxOutboxLag = Math.max(maxOutboxLag, lag / INSTANCES); // gauge is summed across instances; each reports the same value
  } catch {
    /* sampling must never break the run */
  }
}, 1000);
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (performance.now() < stopAt) await oneRequest();
  }),
);
const elapsedS = (performance.now() - startedAt) / 1000;
clearInterval(sampler);

// ---- drain + verify ---------------------------------------------------------------------------
const drainStart = performance.now();
let unpublished = Infinity;
while (performance.now() - drainStart < 120_000) {
  unpublished = ((await scrape()).get('outbox_unpublished_events') ?? 0) / INSTANCES;
  if (unpublished === 0) break;
  await Bun.sleep(250);
}
const drainS = (performance.now() - drainStart) / 1000;

const after = await scrape();
let divergent = 0;
for (const w of wallets) {
  const r = await post(`/wallets/${w.walletId}/reconciliation`, {});
  if (r.json?.consistent !== true) divergent++;
}

// ---- report -----------------------------------------------------------------------------------
latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] ?? 0;
const [pg] = await orm.em.fork().execute<{ v: string }[]>('select version() as v');
const delta = (name: string) => sumMetric(after, name) - sumMetric(before, name);

const report = {
  environment: {
    runtime: `bun ${Bun.version}`,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpus: `${os.cpus().length} x ${os.cpus()[0]?.model.trim()}`,
    memoryGB: Math.round(os.totalmem() / 1e9),
    postgres: pg?.v.split(' on ')[0],
    instances: INSTANCES,
    instanceMode: MODE === 'processes' ? 'one OS process per instance' : 'all instances inside the load generator process',
    note: 'Instances, load generator and (in CI) the databases share one machine; treat numbers as relative, not absolute.',
  },
  methodology: {
    durationSeconds: DURATION_S,
    concurrency: CONCURRENCY,
    wallets: WALLETS,
    hotWalletShare: HOT_SHARE,
    mix: '60% BET, 25% WIN, 10% LOSS, 5% exact replays of recent requests',
    transport: 'HTTP, round-robin across instances, one request per connection slot (closed loop)',
  },
  results: {
    requests: sent,
    throughputRps: Math.round(sent / elapsedS),
    latencyMs: { p50: +pct(50).toFixed(1), p95: +pct(95).toFixed(1), p99: +pct(99).toFixed(1), max: +(latencies[latencies.length - 1] ?? 0).toFixed(1) },
    statusCounts: Object.fromEntries([...statusCounts.entries()].sort()),
    errorRatePercent: +((errors / Math.max(1, sent)) * 100).toFixed(3),
    walletLockConflicts: delta('wallet_lock_conflicts_total'),
    duplicatesAbsorbed: delta('wager_duplicates_total'),
    transientInfraErrors: delta('transient_infra_errors_total'),
    maxOutboxLagSeconds: +maxOutboxLag.toFixed(2),
    outboxDrainSeconds: unpublished === 0 ? +drainS.toFixed(2) : null,
    outboxPublished: delta('outbox_events_published_total'),
    walletsDivergent: divergent,
  },
};

console.log('\n=== Load test report ===');
console.log(JSON.stringify(report, null, 2));
writeFileSync('load-test-report.json', JSON.stringify(report, null, 2));

if (process.env.GITHUB_STEP_SUMMARY) {
  const r = report.results;
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      '## Load test',
      `**Env:** ${report.environment.runtime}, ${report.environment.cpus}, ${report.environment.postgres}, ${INSTANCES} instance(s)`,
      `**Method:** ${DURATION_S}s, concurrency ${CONCURRENCY}, ${WALLETS} wallets (${HOT_SHARE * 100}% to 2 hot wallets)`,
      '',
      '| Metric | Value |',
      '|---|---|',
      `| Throughput | ${r.throughputRps} req/s (${r.requests} requests) |`,
      `| Latency p50 / p95 / p99 | ${r.latencyMs.p50} / ${r.latencyMs.p95} / ${r.latencyMs.p99} ms |`,
      `| Error rate | ${r.errorRatePercent}% |`,
      `| Wallet lock conflicts | ${r.walletLockConflicts} |`,
      `| Max outbox lag / drain | ${r.maxOutboxLagSeconds}s / ${r.outboxDrainSeconds ?? 'not drained'}s |`,
      `| Wallets diverging from ledger | ${r.walletsDivergent} |`,
      '',
    ].join('\n'),
  );
}

for (const inst of instances) await inst.stop();
await orm.close();

// The run fails if money is wrong or the service is unhealthy, whatever the speed.
if (divergent > 0 || errors > 0 || unpublished !== 0) {
  console.error(`\nFAILED: divergent=${divergent} errors=${errors} outboxUndrained=${unpublished}`);
  process.exit(1);
}
