// ============================================================
// OrdersModule — SMS activation lifecycle management
// ============================================================

import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { SmsPollingService } from './sms-polling.service';
import { ProvidersModule } from '../providers/providers.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [
    ProvidersModule,  // needs ProviderRegistryService
    WalletModule,     // needs WalletService for debit/refund
  ],
  providers: [OrdersService, SmsPollingService],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
