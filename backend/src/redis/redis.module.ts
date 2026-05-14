// ============================================================
// RedisModule — global Redis client (caching + queues)
// ============================================================

import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [
    {
      provide: 'REDIS_OPTIONS',
      useFactory: (config: ConfigService) => {
        const host = config.get('REDIS_HOST', 'localhost');
        const port = config.get<number>('REDIS_PORT', 6379);
        const password = config.get('REDIS_PASSWORD') || undefined;
        // Upstash and other cloud Redis providers require TLS
        const useTls = host !== 'localhost' && host !== '127.0.0.1';
        return { host, port, password, ...(useTls ? { tls: {} } : {}) };
      },
      inject: [ConfigService],
    },
    RedisService,
  ],
  exports: [RedisService],
})
export class RedisModule {}
