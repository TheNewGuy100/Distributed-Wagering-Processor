import { Controller, Get, Header, Inject } from '@nestjs/common';
import { MetricsService } from '../../infrastructure/observability/metrics.service';
import { Public } from './auth/auth.port';

@Public()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  /** Prometheus text format. Unauthenticated like the health endpoints; expose it on an internal network only. */
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.render();
  }
}
