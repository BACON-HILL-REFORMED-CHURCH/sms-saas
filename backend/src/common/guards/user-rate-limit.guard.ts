// Per-user Redis sliding-window rate limiter guard.
// Apply with @UseGuards(UserRateLimitGuard) + @UserRateLimit(limit, windowSeconds).
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisService } from '../../redis/redis.service';
import {
  USER_RATE_LIMIT_KEY,
  UserRateLimitOptions,
} from '../decorators/user-rate-limit.decorator';

@Injectable()
export class UserRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const opts = this.reflector.getAllAndOverride<UserRateLimitOptions>(
      USER_RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!opts) return true; // no decorator → skip

    const request = context.switchToHttp().getRequest();
    const userId: string | undefined = request.user?.sub;
    if (!userId) return true; // unauthenticated requests handled by JwtAuthGuard

    const key = `ratelimit:user:${userId}:${context.getClass().name}:${context.getHandler().name}`;
    const client = this.redis.getClient();

    const count = await client.incr(key);
    if (count === 1) {
      await client.expire(key, opts.windowSeconds);
    }

    if (count > opts.limit) {
      throw new HttpException(
        `Rate limit exceeded: max ${opts.limit} requests per ${opts.windowSeconds}s`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
