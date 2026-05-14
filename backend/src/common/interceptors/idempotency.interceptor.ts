import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { RedisService } from '../../redis/redis.service';

const TTL_SECONDS = 86_400; // 24 hours

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly redis: RedisService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const req = context.switchToHttp().getRequest();

    // Only POST requests from authenticated users with the header
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;
    const userId = req.user?.sub as string | undefined;

    if (!idempotencyKey || !userId || req.method !== 'POST') {
      return next.handle();
    }

    // Scope key per user so keys can't leak across accounts
    const redisKey = `idempotency:${userId}:${idempotencyKey}`;
    const cached = await this.redis.get<unknown>(redisKey);

    if (cached !== null) {
      return of(cached);
    }

    return next.handle().pipe(
      tap(async (data) => {
        await this.redis.set(redisKey, data, TTL_SECONDS);
      }),
    );
  }
}
