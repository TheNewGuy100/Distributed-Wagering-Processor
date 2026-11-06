import type { LoggerService, LogLevel } from '@nestjs/common';
import { LogContext } from './log-context';

const LEVEL_ORDER: Record<string, number> = { verbose: 0, debug: 1, log: 2, warn: 3, error: 4, fatal: 5 };
const LEVEL_NAME: Record<string, string> = {
  verbose: 'trace',
  debug: 'debug',
  log: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'fatal',
};

/** Keys that must never reach the logs, whatever a caller passes in. */
const REDACTED_KEYS = /^(authorization|password|secret|token|payload|body|amount|balance|openingCredit)$/i;

/**
 * One JSON object per line on stdout. Carries the ambient LogContext (correlationId, messageId,
 * transactionId, walletId, providerId) and strips payload-like / financial fields.
 */
export class JsonLogger implements LoggerService {
  /** Replaceable output (tests capture lines here). */
  static write: (line: string) => void = (line) => {
    process.stdout.write(line + '\n');
  };

  private readonly min: number;

  constructor(level: string = process.env.LOG_LEVEL ?? 'log') {
    this.min = LEVEL_ORDER[level === 'info' ? 'log' : level] ?? LEVEL_ORDER.log!;
  }

  log(message: unknown, ...rest: unknown[]) {
    this.emit('log', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.emit('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.emit('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.emit('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.emit('verbose', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]) {
    this.emit('fatal', message, rest);
  }
  setLogLevels(_levels: LogLevel[]): void {}

  private emit(level: string, message: unknown, rest: unknown[]): void {
    if ((LEVEL_ORDER[level] ?? 2) < this.min) return;

    // Nest convention: the last string argument is the context; for errors a stack may precede it.
    const strings = rest.filter((r): r is string => typeof r === 'string');
    const context = strings.length > 0 ? strings[strings.length - 1] : undefined;
    const stack = level === 'error' && strings.length > 1 ? strings[0] : undefined;

    const line: Record<string, unknown> = {
      time: new Date().toISOString(),
      level: LEVEL_NAME[level] ?? level,
      ...(context ? { context } : {}),
    };

    if (message !== null && typeof message === 'object' && !(message instanceof Error)) {
      for (const [k, v] of Object.entries(message as Record<string, unknown>)) {
        if (!REDACTED_KEYS.test(k)) line[k] = v;
      }
      line.msg ??= line.event ?? '';
    } else if (message instanceof Error) {
      line.msg = message.message;
      line.stack = message.stack;
    } else {
      line.msg = String(message);
    }
    if (stack) line.stack = stack;

    // Ambient identifiers last so a caller cannot spoof them.
    Object.assign(line, LogContext.get());
    JsonLogger.write(JSON.stringify(line, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  }
}
