// ============================================================
// Root AppModule — registers all feature modules
// ============================================================

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { RechargeModule } from './recharge/recharge.module';
import { QueueModule } from './queue/queue.module';
import { RedisModule } from './redis/redis.module';

// Feature modules
import { AuthModule }      from './auth/auth.module';
import { UsersModule }     from './users/users.module';
import { WalletModule }    from './wallet/wallet.module';
import { ProvidersModule }  from './providers/providers.module';
import { OrdersModule }     from './orders/orders.module';
import { AdminModule }      from './admin/admin.module';
import { EsimModule }       from './esim/esim.module';

@Module({
  imports: [
    // Config — loads .env automatically
    ConfigModule.forRoot({ isGlobal: true }),

    // Rate limiting — 100 requests / 60s per IP (global)
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),

    // Cron jobs / polling
    ScheduleModule.forRoot(),

    // Core infrastructure
    PrismaModule,
    RedisModule,
    QueueModule,
    RechargeModule,

    // Feature modules
    AuthModule,
    UsersModule,
    WalletModule,
    ProvidersModule,
    OrdersModule,
    AdminModule,
    EsimModule,
  ],
})
export class AppModule {}
