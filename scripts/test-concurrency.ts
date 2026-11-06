// Runs only the concurrency / multi-instance / crash-recovery scenarios (cross-platform: no shell quoting).
const pattern = 'concurrency|three instances|two instances|racing|shutdown|dying|worker instances|restart';
const proc = Bun.spawn(
  [
    process.execPath,
    'test',
    'test/integration/wagering.http.test.ts',
    'test/integration/sqs.consumer.test.ts',
    'test/integration/outbox.publisher.test.ts',
    'test/integration/pending-and-reconciliation.test.ts',
    '--timeout',
    '90000',
    '-t',
    pattern,
  ],
  { stdout: 'inherit', stderr: 'inherit' },
);
process.exit(await proc.exited);

export {};
