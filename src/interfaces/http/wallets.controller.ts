import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ReconciliationService } from '../../application/wallet/reconciliation-service';
import { WalletService } from '../../application/wallet/wallet-service';
import { RequireRoles, Role } from './auth/auth.port';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(WalletService) private readonly wallets: WalletService,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
  ) {}

  /** Read-only audit: reports (and flags) divergences, never corrects them. */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  @RequireRoles(Role.WalletReconcile)
  reconcile(@Param('walletId') walletId: string) {
    return this.reconciliation.reconcile(walletId);
  }

  @Post()
  @HttpCode(201)
  @RequireRoles(Role.WalletWrite)
  create(@Body() body: unknown) {
    return this.wallets.create(body);
  }

  @Get(':walletId')
  @RequireRoles(Role.WalletRead)
  get(@Param('walletId') walletId: string) {
    return this.wallets.get(walletId);
  }

  @Get(':walletId/ledger')
  @RequireRoles(Role.WalletRead)
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.wallets.ledger(walletId, cursor, limit);
  }
}
