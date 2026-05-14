import { Module } from '@nestjs/common';
import { AbuseService } from './abuse.service';
import { RedisModule } from '../redis/redis.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [RedisModule, PrismaModule],
  providers: [AbuseService],
  exports: [AbuseService],
})
export class AbuseModule {}
