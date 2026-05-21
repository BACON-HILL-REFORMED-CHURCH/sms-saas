import { Module, forwardRef } from '@nestjs/common';
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
      useFactory: (config: ConfigService) => {
        const url = process.env.REDIS_URL;
        if (url) {
          const parsed = new URL(url);
          const isTLS = url.startsWith('rediss://');
          return {
            connection: {
              host: parsed.hostname,
              port: parseInt(parsed.port, 10) || 6379,
              password: parsed.password || undefined,
              username: parsed.username || undefined,
              tls: isTLS ? {} : undefined,
              maxRetriesPerRequest: null,
              enableOfflineQueue: false,
            },
          };
        }
        const host = config.get('REDIS_HOST', 'localhost');
        const port = config.get<number>('REDIS_PORT', 6379);
        const password = config.get('REDIS_PASSWORD') || undefined;
        const useTls = host !== 'localhost' && host !== '127.0.0.1';
        return {
          connection: {
            host, port, password,
            ...(useTls ? { tls: {} } : {}),
            maxRetriesPerRequest: null,
            enableOfflineQueue: false,
          },
        };
      },
    }),
    BullModule.registerQueue({ name: SMS_QUEUE }),
    forwardRef(() => OrdersModule),
  ],
  providers: [SmsProcessor, SmsQueueService],
  exports: [SmsQueueService],
})
export class QueueModule {}
