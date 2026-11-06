import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { JsonLogger } from './json-logger';
import { LogContext } from './log-context';
import { MetricsService } from './metrics.service';

describe('JsonLogger', () => {
  const lines: string[] = [];
  const original = JsonLogger.write;
  beforeEach(() => {
    lines.length = 0;
    JsonLogger.write = (l) => lines.push(l);
  });
  afterEach(() => {
    JsonLogger.write = original;
  });
  const last = () => JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;

  test('emits one JSON object per line with level, time, context and message', () => {
    new JsonLogger().log('hello', 'MyContext');
    expect(last()).toMatchObject({ level: 'info', context: 'MyContext', msg: 'hello' });
    expect(new Date(last().time as string).toString()).not.toBe('Invalid Date');
  });

  test('merges the ambient log context into every line', () => {
    LogContext.run({ correlationId: 'c-1', messageId: 'm-1' }, () => {
      LogContext.set({ walletId: 'w-1', transactionId: 't-1', providerId: 'p-1' });
      new JsonLogger().warn({ event: 'something' }, 'Ctx');
    });
    expect(last()).toMatchObject({
      level: 'warn',
      event: 'something',
      correlationId: 'c-1',
      messageId: 'm-1',
      walletId: 'w-1',
      transactionId: 't-1',
      providerId: 'p-1',
    });
  });

  test('context does not leak between concurrent scopes', async () => {
    const logger = new JsonLogger();
    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        LogContext.run({ correlationId: id }, async () => {
          await Bun.sleep(Math.random() * 10);
          logger.log({ event: 'x' });
        }),
      ),
    );
    const ids = lines.map((l) => (JSON.parse(l) as { correlationId: string }).correlationId).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(LogContext.get()).toEqual({});
  });

  test('strips payload-like and financial fields', () => {
    new JsonLogger().log({
      event: 'e',
      amount: '10.00',
      balance: '5.00',
      body: { secret: 1 },
      payload: 'x',
      authorization: 'Bearer t',
      status: 'PROCESSED',
    });
    const l = last();
    for (const k of ['amount', 'balance', 'body', 'payload', 'authorization']) expect(l).not.toHaveProperty(k);
    expect(l.status).toBe('PROCESSED');
  });

  test('ambient identifiers cannot be spoofed by the message object', () => {
    LogContext.run({ correlationId: 'real' }, () => new JsonLogger().log({ event: 'e', correlationId: 'fake' }));
    expect(last().correlationId).toBe('real');
  });

  test('serializes errors with stack and honours the level threshold', () => {
    new JsonLogger('warn').log('dropped');
    expect(lines).toHaveLength(0);
    new JsonLogger('warn').error(new Error('boom'));
    expect(last()).toMatchObject({ level: 'error', msg: 'boom' });
    expect(typeof last().stack).toBe('string');
  });
});

describe('MetricsService', () => {
  test('counters with labels, totals and Prometheus rendering', async () => {
    const m = new MetricsService();
    m.describe('things_total', 'Things');
    m.inc('things_total', { kind: 'a', status: 'ok' });
    m.inc('things_total', { status: 'ok', kind: 'a' }, 2); // label order is irrelevant
    m.inc('things_total', { kind: 'b', status: 'bad' });
    expect(m.get('things_total', { kind: 'a', status: 'ok' })).toBe(3);
    expect(m.total('things_total')).toBe(4);
    expect(m.get('missing')).toBe(0);
    const text = await m.render();
    expect(text).toContain('# HELP things_total Things');
    expect(text).toContain('# TYPE things_total counter');
    expect(text).toContain('things_total{kind="a",status="ok"} 3');
  });

  test('histograms are cumulative and carry sum/count', async () => {
    const m = new MetricsService();
    m.observe('lat_seconds', 0.004, { source: 'http' });
    m.observe('lat_seconds', 0.2, { source: 'http' });
    m.observe('lat_seconds', 9, { source: 'http' });
    const text = await m.render();
    expect(text).toContain('lat_seconds_bucket{le="0.005",source="http"} 1');
    expect(text).toContain('lat_seconds_bucket{le="0.25",source="http"} 2');
    expect(text).toContain('lat_seconds_bucket{le="5",source="http"} 2');
    expect(text).toContain('lat_seconds_bucket{le="+Inf",source="http"} 3');
    expect(text).toContain('lat_seconds_count{source="http"} 3');
    expect(m.histogramCount('lat_seconds', { source: 'http' })).toBe(3);
  });

  test('gauges are computed at scrape time and a failing gauge does not break the scrape', async () => {
    const m = new MetricsService();
    let v = 1;
    m.gauge('depth', 'Depth', () => [{ value: v }]);
    m.gauge('broken', 'Broken', () => {
      throw new Error('db down');
    });
    expect(await m.render()).toContain('depth 1');
    v = 7;
    const text = await m.render();
    expect(text).toContain('depth 7');
    expect(text).toContain('# gauge broken unavailable');
  });
});
