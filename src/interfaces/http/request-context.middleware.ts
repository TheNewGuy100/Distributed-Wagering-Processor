import { Inject, Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { LogContext } from '../../infrastructure/observability/log-context';
import { MetricsService } from '../../infrastructure/observability/metrics.service';

const SAFE_ID = /^[\w.:-]{1,128}$/;

/** Assigns/propagates the correlation id, then records one access-log line and HTTP metrics per request. */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger('Http');

  constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {
    this.metrics.describe('http_requests_total', 'HTTP requests by method, route and status');
    this.metrics.describe('http_request_duration_seconds', 'HTTP request duration');
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header('x-correlation-id');
    const correlationId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-correlation-id', correlationId);
    const start = performance.now();

    LogContext.run({ correlationId }, () => {
      const ctx = LogContext.get(); // same object the handlers enrich (walletId, transactionId, ...)
      res.on('finish', () => {
        LogContext.run(ctx, () => {
          const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
          const seconds = (performance.now() - start) / 1000;
          this.metrics.inc('http_requests_total', { method: req.method, route, status: String(res.statusCode) });
          this.metrics.observe('http_request_duration_seconds', seconds, { route });
          if (route !== '/health/live' && route !== '/health/ready' && route !== '/metrics') {
            this.logger.log({
              event: 'http_request',
              method: req.method,
              route,
              status: res.statusCode,
              durationMs: Math.round(seconds * 1000),
            });
          }
        });
      });
      next();
    });
  }
}
