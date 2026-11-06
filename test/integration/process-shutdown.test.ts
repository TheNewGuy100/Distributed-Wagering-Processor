import { describe, expect, test } from 'bun:test';

/**
 * A real process, a real SIGTERM (what `docker stop` and Kubernetes send), run as PID 1 like in a container.
 * Guards two things the in-process tests cannot see: that shutdown is graceful (the hooks ran, exit code 0) and that
 * it FINISHES promptly. A shutdown-grace timer left pending used to keep the process alive for the whole grace
 * period (20 s) after everything else had stopped; run any other way, the signal Nest re-raises would hide that.
 *
 * POSIX signals do not exist on Windows (the child would just be terminated), so this runs on Linux/macOS (CI).
 */
const supported = process.platform !== 'win32';
const port = 3917;
const suffix = Date.now().toString(36);

async function waitReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://localhost:${port}/health/ready`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await Bun.sleep(200);
  }
  throw new Error('the application did not become ready');
}

describe.skipIf(!supported)('process lifecycle (SIGTERM)', () => {
  test('stops gracefully and promptly even with the consumer and outbox running and a long grace period', async () => {
    const proc = Bun.spawn([process.execPath, 'test/integration/fixtures/pid1-like.ts'], {
      env: {
        ...process.env,
        PORT: String(port),
        SQS_QUEUE_NAME: `ps-wagers-${suffix}.fifo`,
        SQS_DLQ_NAME: `ps-dlq-${suffix}.fifo`,
        SQS_EVENTS_QUEUE_NAME: `ps-events-${suffix}.fifo`,
        SQS_CONSUMER_ENABLED: 'true',
        OUTBOX_ENABLED: 'true',
        PENDING_WORKER_ENABLED: 'true',
        // Deliberately long: a leaked grace timer would make the process linger this long.
        SQS_SHUTDOWN_GRACE_MS: '30000',
        OUTBOX_SHUTDOWN_GRACE_MS: '30000',
        SQS_WAIT_TIME_SECONDS: '5',
        LOG_LEVEL: 'log',
      },
      stdout: 'pipe',
      stderr: 'ignore',
    });

    try {
      await waitReady(30_000);
      const started = performance.now();
      proc.kill('SIGTERM');
      const code = await Promise.race([
        proc.exited,
        Bun.sleep(15_000).then(() => 'still running after 15 s' as const),
      ]);
      const elapsedMs = performance.now() - started;

      // Run as PID 1 (see the fixture): the signal Nest re-raises is ignored, so the process ends with 0 only once
      // its event loop is empty. A leaked timer or handle shows up here as a slow exit.
      expect(code).toBe(0);
      expect(elapsedMs).toBeLessThan(8_000); // far below the 30 s grace periods

      // And the hooks really ran (a bare kill would also exit quickly): both workers logged a drained shutdown.
      const stdout = await new Response(proc.stdout).text();
      const logs = stdout
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .map((l) => JSON.parse(l) as { event?: string; component?: string; result?: string });
      const shutdowns = logs.filter((l) => l.event === 'shutdown');
      expect(shutdowns.map((l) => l.component).sort()).toEqual(['outbox-publisher', 'sqs-consumer']);
      for (const l of shutdowns) expect(l.result).toBe('drained');
    } finally {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
  }, 60_000);
});
