import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { SmsProcessor } from './sms.processor';
import { SmsQueueService } from './sms.queue';
import { OrdersModule } from '../orders/orders.module';
import { SMS_QUEUE } from './sms.queue';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get('REDIS_HOST'),
          port: config.get<number>('REDIS_PORT'),
          password: config.get('REDIS_PASSWORD'),
          tls: {},
        },
      }),
    }),
    BullModule.registerQueue({ name: SMS_QUEUE }),
    OrdersModule,
  ],
  providers: [SmsProcessor, SmsQueueService],
  exports: [SmsQueueService],
})
export class QueueModule {}
