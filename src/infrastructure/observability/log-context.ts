import { AsyncLocalStorage } from 'node:async_hooks';

export type LogFields = Record<string, string | number | boolean | null | undefined>;

const storage = new AsyncLocalStorage<LogFields>();

/**
 * Per-request / per-message log context (correlation id, message id, transaction id, wallet id,
 * provider id). Every log line emitted while it is active carries these fields automatically.
 */
export const LogContext = {
  run<T>(fields: LogFields, fn: () => T): T {
    return storage.run({ ...storage.getStore(), ...fields }, fn);
  },
  /** Adds fields to the active context; a no-op outside one. */
  set(fields: LogFields): void {
    const store = storage.getStore();
    if (store) Object.assign(store, fields);
  },
  get(): LogFields {
    return storage.getStore() ?? {};
  },
};
