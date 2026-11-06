import { SQSClient } from '@aws-sdk/client-sqs';
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AUTHENTICATOR, AuthGuard, NoopAuthenticator } from './interfaces/http/auth/auth.port';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import config from './infrastructure/persistence/mikro-orm.config';
import { ProcessWagerTransaction } from './application/wager/process-wager-transaction';
import { ConsumerHooks, WagerMessageHandler } from './application/wager/wager-message-handler';
import { WalletService } from './application/wallet/wallet-service';
import { PENDING_CONFIG, loadPendingConfig } from './application/wager/pending-reference.config';
import { PendingReferenceWorker } from './application/wager/pending-reference-worker';
import { ReconciliationService } from './application/wallet/reconciliation-service';
import { MetricsBootstrap } from './infrastructure/observability/metrics-bootstrap';
import { MetricsService } from './infrastructure/observability/metrics.service';
import { MetricsController } from './interfaces/http/metrics.controller';
import { RequestContextMiddleware } from './interfaces/http/request-context.middleware';
import { OUTBOX_CONFIG, loadOutboxConfig } from './infrastructure/outbox/outbox.config';
import { OutboxHooks, OutboxPublisher } from './infrastructure/outbox/outbox-publisher.service';
import { SQS_CLIENT, SQS_CONFIG, loadSqsConfig, type SqsConfig } from './infrastructure/sqs/sqs.config';
import { SqsQueues } from './infrastructure/sqs/sqs-queues.service';
import { HealthController } from './interfaces/http/health.controller';
import { HttpErrorFilter } from './interfaces/http/http-exception.filter';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';
import { SqsConsumer } from './interfaces/sqs/sqs-consumer.service';

@Module({
  imports: [MikroOrmModule.forRoot(config)],
  controllers: [HealthController, WalletsController, WageringController, MetricsController],
  providers: [
    { provide: SQS_CONFIG, useFactory: () => loadSqsConfig() },
    {
      provide: SQS_CLIENT,
      inject: [SQS_CONFIG],
      useFactory: (c: SqsConfig) =>
        new SQSClient({
          region: c.region,
          ...(c.endpoint ? { endpoint: c.endpoint } : {}),
        }),
    },
    SqsQueues,
    MetricsService,
    MetricsBootstrap,
    ReconciliationService,
    { provide: PENDING_CONFIG, useFactory: () => loadPendingConfig() },
    PendingReferenceWorker,
    { provide: OUTBOX_CONFIG, useFactory: () => loadOutboxConfig() },
    OutboxHooks,
    OutboxPublisher,
    ConsumerHooks,
    ProcessWagerTransaction,
    WagerMessageHandler,
    SqsConsumer,
    WalletService,
    { provide: APP_FILTER, useClass: HttpErrorFilter },
    { provide: AUTHENTICATOR, useClass: NoopAuthenticator },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
