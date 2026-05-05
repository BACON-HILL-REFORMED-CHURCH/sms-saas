// ============================================================
// WalletModule — balance management + transaction history
// ============================================================

import { Module } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';

@Module({
  providers: [WalletService],
  controllers: [WalletController],
  exports: [WalletService], // exported so OrdersModule can debit balance
})
export class WalletModule {}
