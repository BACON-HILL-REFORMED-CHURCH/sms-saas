import { Module } from '@nestjs/common';
import { RechargeService } from './recharge.service';
import { RechargeController } from './recharge.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { WalletModule } from '../wallet/wallet.module';
import { RedisModule } from '../redis/redis.module';
import { AbuseModule } from '../abuse/abuse.module';

@Module({
  imports: [PrismaModule, WalletModule, RedisModule, AbuseModule],
  controllers: [RechargeController],
  providers: [RechargeService],
})
export class RechargeModule {}
