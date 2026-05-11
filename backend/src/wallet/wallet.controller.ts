// ============================================================
// WalletController — user-facing wallet endpoints
// ============================================================

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TransactionType } from '@prisma/client';
import { WalletService } from './wallet.service';
import { CryptomUsService } from './cryptomus.service';
import { DepositDto, CryptoDepositDto } from './dto/wallet.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';

@Controller('wallet')
@UseGuards(JwtAuthGuard) // All wallet routes require auth
export class WalletController {
  private readonly logger = new Logger(WalletController.name);

  constructor(
    private readonly walletService: WalletService,
    private readonly cryptomUs: CryptomUsService,
  ) {}

  /**
   * GET /api/v1/wallet/balance
   * Returns current balance
   */
  @Get('balance')
  getBalance(@CurrentUser() user: JwtPayload) {
    return this.walletService.getBalance(user.sub);
  }

  /**
   * POST /api/v1/wallet/deposit
   * Body: { amount (cents), method }
   * Legacy / admin mock endpoint
   */
  @Post('deposit')
  deposit(@CurrentUser() user: JwtPayload, @Body() dto: DepositDto) {
    return this.walletService.deposit(user.sub, dto);
  }

  /**
   * POST /api/v1/wallet/deposit/crypto
   * Body: { amountUsd: number } — in USD dollars (e.g. 10 = $10.00)
   * Creates a Cryptomus payment and returns payment details
   */
  @Post('deposit/crypto')
  async depositCrypto(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CryptoDepositDto,
  ) {
    const orderId = `dep_${user.sub}_${randomUUID()}`;
    const amountUsd = dto.amountUsd; // already in dollars

    const payment = await this.cryptomUs.createPayment(amountUsd, orderId);
    this.logger.log(`Crypto deposit created: user=${user.sub} amount=$${amountUsd} uuid=${payment.uuid}`);

    // Store pending deposit in metadata (use description field of a pending txn)
    // We track it by uuid; actual credit happens on check
    return {
      uuid: payment.uuid,
      address: payment.address,
      amount: payment.amount,
      currency: payment.currency,
      network: payment.network,
      url: payment.url,
      orderId,
    };
  }

  /**
   * GET /api/v1/wallet/deposit/check/:uuid
   * Polls Cryptomus for payment status.
   * If paid → credits user balance (idempotent via transaction check)
   */
  @Get('deposit/check/:uuid')
  async checkDeposit(
    @CurrentUser() user: JwtPayload,
    @Param('uuid') uuid: string,
  ) {
    const status = await this.cryptomUs.getPaymentStatus(uuid);
    const isPaid = status.status === 'paid' || status.status === 'paid_over';

    if (isPaid) {
      // Check if already credited (look for a DEPOSIT txn with this uuid in description)
      const alreadyCredited = await this.walletService.isCryptoAlreadyCredited(uuid);

      if (!alreadyCredited) {
        const amountUsd = parseFloat(status.amount) || 0;
        const amountCents = Math.round(amountUsd * 100);
        if (amountCents > 0) {
          await this.walletService.atomicCredit(
            user.sub,
            amountCents,
            TransactionType.DEPOSIT,
            `Crypto deposit — ${status.amount} ${status.currency} [${uuid}]`,
          );
          this.logger.log(`Crypto credited: user=${user.sub} amount=${amountCents}¢ uuid=${uuid}`);
        }
      }
    }

    return {
      uuid,
      status: status.status,
      credited: isPaid,
    };
  }

  /**
   * GET /api/v1/wallet/history?page=1&limit=20
   * Returns paginated transaction list
   */
  @Get('history')
  getHistory(
    @CurrentUser() user: JwtPayload,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.walletService.getHistory(user.sub, page, limit);
  }
}
