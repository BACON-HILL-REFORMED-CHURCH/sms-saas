import { SetMetadata } from '@nestjs/common';

export const USER_RATE_LIMIT_KEY = 'userRateLimit';

export interface UserRateLimitOptions {
  limit: number;
  windowSeconds: number;
}

export const UserRateLimit = (limit: number, windowSeconds: number) =>
  SetMetadata(USER_RATE_LIMIT_KEY, { limit, windowSeconds } satisfies UserRateLimitOptions);
