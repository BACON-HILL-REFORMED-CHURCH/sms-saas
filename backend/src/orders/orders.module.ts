import { Module, forwardRef } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { ProvidersModule } from '../providers/providers.module';
import { WalletModule } from '../wallet/wallet.module';
import { QueueModule } from '../queue/queue.module';
import { RedisModule } from '../redis/redis.module';
import { AbuseModule } from '../abuse/abuse.module';

@Module({
  imports: [
    ProvidersModule,
    WalletModule,
    forwardRef(() => QueueModule),
    RedisModule,
    AbuseModule,
  ],
  providers: [OrdersService],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
