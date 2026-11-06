import { EntityManager } from '@mikro-orm/postgresql';
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { SqsQueues } from '../../infrastructure/sqs/sqs-queues.service';
import { Public } from './auth/auth.port';

/** Unauthenticated on purpose: orchestrators probe these. */
@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(SqsQueues) private readonly sqs: SqsQueues,
  ) {}

  /** Liveness: the process is up. No dependencies are touched. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL and SQS must both be reachable. */
  @Get('ready')
  async ready() {
    const [pg, sqs] = await Promise.allSettled([
      this.em.fork().execute('select 1', []),
      this.sqs.ping(),
    ]);
    const checks = {
      postgres: pg.status === 'fulfilled' ? 'up' : 'down',
      sqs: sqs.status === 'fulfilled' ? 'up' : 'down',
    };
    if (checks.postgres === 'down' || checks.sqs === 'down') {
      throw new ServiceUnavailableException({ status: 'unavailable', checks });
    }
    return { status: 'ok', checks };
  }
}
