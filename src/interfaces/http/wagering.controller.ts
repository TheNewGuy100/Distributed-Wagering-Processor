import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import type { Response } from 'express';
import { TransactionNotFoundError } from '../../application/errors';
import { ProcessWagerTransaction } from '../../application/wager/process-wager-transaction';
import {
  getTransactionView,
  getTransactionViewByExternal,
} from '../../application/wager/transaction-view';
import { parseWagerCommand } from '../../application/wager/wager-command';
import { assertUuid } from '../../application/validation';
import { CurrentPrincipal, ProviderAccessPolicy, RequireRoles, Role, type Principal } from './auth/auth.port';

@Controller()
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processor: ProcessWagerTransaction,
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(ProviderAccessPolicy) private readonly providers: ProviderAccessPolicy,
  ) {}

  /**
   * Status contract (same for every endpoint that reports a wager outcome):
   *  201 processed now | 200 idempotent replay of a processed tx | 202 pending reference |
   *  422 business rejection | 400 invalid payload | 401/403 not authenticated / not allowed |
   *  409 idempotency conflict | 503 transient infra failure.
   */
  @Post('wagering/transactions')
  @RequireRoles(Role.WagerSubmit)
  async process(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cmd = parseWagerCommand(body, idempotencyKey);
    this.providers.assert(principal, cmd.providerId); // a provider-scoped token can only submit for its own provider
    const result = await this.processor.execute(cmd);
    const { status } = result.transaction;
    res.status(
      status === 'PENDING_REFERENCE' ? 202 : status === 'PROCESSED' ? (result.idempotentReplay ? 200 : 201) : 422,
    );
    return { ...result.transaction, idempotentReplay: result.idempotentReplay };
  }

  @Get('wagering/transactions/:transactionId')
  @RequireRoles(Role.WagerRead)
  async byId(@Param('transactionId') transactionId: string, @CurrentPrincipal() principal: Principal) {
    const view = await getTransactionView(this.em.fork(), assertUuid(transactionId, 'transactionId'));
    // Another provider's transaction is reported as not found, so its existence is not disclosed.
    if (!this.providers.allows(principal, view.providerId)) throw new TransactionNotFoundError();
    return view;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @RequireRoles(Role.WagerRead)
  byExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    this.providers.assert(principal, providerId);
    return getTransactionViewByExternal(this.em.fork(), providerId, externalId);
  }
}
