import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [
    {
      provide: 'REDIS_OPTIONS',
      useFactory: () => {
        const url = process.env.REDIS_URL;
        if (url) {
          const parsed = new URL(url);
          const isTLS = url.startsWith('rediss://');
          return {
            host: parsed.hostname,
            port: parseInt(parsed.port, 10) || 6379,
            password: parsed.password || undefined,
            username: parsed.username || undefined,
            tls: isTLS ? {} : undefined,
            maxRetriesPerRequest: null,
            enableOfflineQueue: false,
          };
        }
        return {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379', 10),
          password: process.env.REDIS_PASSWORD || undefined,
          maxRetriesPerRequest: null,
          enableOfflineQueue: false,
        };
      },
    },
    RedisService,
  ],
  exports: [RedisService],
})
export class RedisModule {}
