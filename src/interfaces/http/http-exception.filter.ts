import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Inject, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ApplicationError } from '../../application/errors';
import { DomainError } from '../../domain/errors';
import { MetricsService } from '../../infrastructure/observability/metrics.service';

const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION_ERROR: 400,
  WALLET_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  WALLET_ALREADY_EXISTS: 409,
};

/** Infrastructure failures that are worth retrying (connection loss, deadlock, serialization, shutdown). */
export function isTransientInfraError(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown };
  const code = typeof err?.code === 'string' ? err.code : '';
  if (/^(08|40|53|57)/.test(code) || code === '55P03') return true; // PostgreSQL classes
  if (/^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND)$/.test(code)) return true;
  const msg = typeof err?.message === 'string' ? err.message : '';
  return /connection (terminated|refused|timeout)|timeout exceeded when trying to connect/i.test(msg);
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof ApplicationError) {
      res
        .status(STATUS_BY_CODE[exception.code] ?? 400)
        .json({ error: { code: exception.code, message: exception.message } });
      return;
    }
    if (exception instanceof DomainError) {
      res.status(422).json({ error: { code: exception.code, message: exception.message } });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      res.status(status).json({ error: { code: status === 400 ? 'VALIDATION_ERROR' : 'HTTP_ERROR', message: exception.message } });
      return;
    }
    if (isTransientInfraError(exception)) {
      this.metrics.inc('transient_infra_errors_total', { code: String((exception as { code?: unknown })?.code ?? 'unknown') });
      this.logger.warn(`transient infrastructure failure: ${(exception as Error)?.message}`);
      res.setHeader('Retry-After', '1');
      res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'temporary infrastructure failure, retry later' } });
      return;
    }
    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'unexpected error' } });
  }
}
