import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import type { Response } from 'express';
import { ProcessWagerTransaction } from '../../application/wager/process-wager-transaction';
import {
  getTransactionView,
  getTransactionViewByExternal,
} from '../../application/wager/transaction-view';
import { parseWagerCommand } from '../../application/wager/wager-command';
import { assertUuid } from '../../application/validation';

@Controller()
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processor: ProcessWagerTransaction,
    @Inject(EntityManager) private readonly em: EntityManager,
  ) {}

  /**
   * Status contract (same for every endpoint that reports a wager outcome):
   *  201 processed now | 200 idempotent replay of a processed tx | 202 pending reference |
   *  422 business rejection | 400 invalid payload | 409 idempotency conflict | 503 transient infra failure.
   */
  @Post('wagering/transactions')
  async process(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.processor.execute(parseWagerCommand(body, idempotencyKey));
    const { status } = result.transaction;
    res.status(
      status === 'PENDING_REFERENCE' ? 202 : status === 'PROCESSED' ? (result.idempotentReplay ? 200 : 201) : 422,
    );
    return { ...result.transaction, idempotentReplay: result.idempotentReplay };
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId') transactionId: string) {
    return getTransactionView(this.em.fork(), assertUuid(transactionId, 'transactionId'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternal(@Param('providerId') providerId: string, @Param('externalTransactionId') externalId: string) {
    return getTransactionViewByExternal(this.em.fork(), providerId, externalId);
  }
}
