import {
  DeleteMessageBatchCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventStore } from './store';

const asset = (name: string): string => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');

/** Same discipline as the API's console: own script/style only, same-origin requests, nothing framed. */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export interface ConsumerOptions {
  sqs: SQSClient;
  queueName: string;
  /** 0 picks a free port (tests). */
  port: number;
  /** Long-poll wait; short in tests so shutdown is quick even without abort support. */
  waitTimeSeconds?: number;
  log?: (line: string) => void;
}

export interface RunningConsumer {
  port: number;
  store: EventStore;
  /** Stops polling, lets the batch in hand finish, closes the HTTP server. */
  stop(): Promise<void>;
}

/** Sleep that can be interrupted, and that never leaves a timer pending (a leaked one keeps the process alive). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

export async function startEventsConsumer(opts: ConsumerOptions): Promise<RunningConsumer> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const store = new EventStore();
  const abort = new AbortController();

  const security = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  };
  const server = Bun.serve({
    port: opts.port,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });
      switch (url.pathname) {
        case '/':
          return new Response(asset('index.html'), { headers: { ...security, 'Content-Type': 'text/html; charset=utf-8' } });
        case '/app.js':
          return new Response(asset('app.js'), { headers: { ...security, 'Content-Type': 'text/javascript; charset=utf-8' } });
        case '/app.css':
          return new Response(asset('app.css'), { headers: { ...security, 'Content-Type': 'text/css; charset=utf-8' } });
        case '/healthz':
          return Response.json({ status: 'ok' });
        case '/api/events': {
          const since = Number(url.searchParams.get('since') ?? '0');
          return Response.json(
            { stats: store.stats, events: store.since(Number.isFinite(since) ? since : 0) },
            { headers: { 'Cache-Control': 'no-store' } },
          );
        }
        default:
          return new Response('not found', { status: 404 });
      }
    },
  });

  // The API creates the queue when it starts: wait for it instead of failing, so start order does not matter.
  const queueUrl = async (): Promise<string | null> => {
    while (!abort.signal.aborted) {
      try {
        return (await opts.sqs.send(new GetQueueUrlCommand({ QueueName: opts.queueName }), { abortSignal: abort.signal })).QueueUrl!;
      } catch {
        if (abort.signal.aborted) return null;
        log(`waiting for queue ${opts.queueName}...`);
        await sleep(2000, abort.signal);
      }
    }
    return null;
  };

  const loop = (async () => {
    const url = await queueUrl();
    if (!url) return;
    log(`consuming ${opts.queueName}`);
    while (!abort.signal.aborted) {
      try {
        const res = await opts.sqs.send(
          new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: opts.waitTimeSeconds ?? 5 }),
          { abortSignal: abort.signal },
        );
        const messages = res.Messages ?? [];
        if (messages.length === 0) continue;
        for (const m of messages) {
          const rec = store.ingest(m.MessageId ?? '', m.Body ?? '');
          log(JSON.stringify({ n: rec.n, status: rec.status, eventType: rec.eventType, aggregateId: rec.aggregateId, outOfOrder: rec.outOfOrder }));
        }
        // Acknowledge only after the events were recorded (invalid ones too: a poison message must not loop forever).
        await opts.sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: url,
            Entries: messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })),
          }),
        );
      } catch (e) {
        if (abort.signal.aborted) return;
        log(`receive failed, retrying: ${(e as Error).message}`);
        await sleep(1000, abort.signal);
      }
    }
  })();

  return {
    port: server.port!,
    store,
    async stop() {
      abort.abort();
      await loop;
      await server.stop(true);
    },
  };
}
