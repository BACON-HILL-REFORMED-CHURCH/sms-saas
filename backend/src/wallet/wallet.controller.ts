// ============================================================
// WalletController — user-facing wallet endpoints
// ============================================================

import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { WalletService } from './wallet.service';
import { DepositDto } from './dto/wallet.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';

@Controller('wallet')
@UseGuards(JwtAuthGuard) // All wallet routes require auth
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

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
   */
  @Post('deposit')
  deposit(@CurrentUser() user: JwtPayload, @Body() dto: DepositDto) {
    return this.walletService.deposit(user.sub, dto);
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
