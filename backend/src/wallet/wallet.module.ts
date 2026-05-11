// ============================================================
// WalletModule — balance management + transaction history
// ============================================================

import { Module } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { CryptomUsService } from './cryptomus.service';

@Module({
  providers: [WalletService, CryptomUsService],
  controllers: [WalletController],
  exports: [WalletService], // exported so OrdersModule can debit balance
})
export class WalletModule {}
