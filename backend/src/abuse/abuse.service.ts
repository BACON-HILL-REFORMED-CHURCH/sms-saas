import {
  Injectable,
  HttpException,
  HttpStatus,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { OrderStatus } from '@prisma/client';

@Injectable()
export class AbuseService {
  private readonly logger = new Logger(AbuseService.name);

  private readonly maxPendingOrders:    number;
  private readonly maxOrdersPerHour:    number;
  private readonly orderDedupSeconds:   number;
  private readonly maxRechargesPerDay:  number;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.maxPendingOrders   = config.get<number>('ABUSE_MAX_PENDING_ORDERS',   3);
    this.maxOrdersPerHour   = config.get<number>('ABUSE_MAX_ORDERS_PER_HOUR', 20);
    this.orderDedupSeconds  = config.get<number>('ABUSE_ORDER_DEDUP_SECONDS', 30);
    this.maxRechargesPerDay = config.get<number>('ABUSE_MAX_RECHARGES_PER_DAY', 10);
  }

  /**
   * Called before creating an order. Throws if any abuse limit is exceeded.
   * Checks (in order):
   *   1. Duplicate order within dedup window (same service+country)
   *   2. Too many concurrent PENDING orders
   *   3. Hourly order velocity
   */
  async checkOrderCreation(userId: string, service: string, country: string): Promise<void> {
    const client = this.redis.getClient();

    // 1. Dedup: block same service+country within the dedup window
    const dedupKey = `abuse:dedup:${userId}:${service}:${country}`;
    const isDedup = await client.set(dedupKey, '1', 'EX', this.orderDedupSeconds, 'NX');
    if (isDedup === null) {
      // Key already existed — duplicate detected
      throw new BadRequestException(
        `Duplicate order: please wait ${this.orderDedupSeconds}s before ordering the same service+country again`,
      );
    }

    // 2. Max concurrent PENDING orders
    const pendingCount = await this.prisma.order.count({
      where: { userId, status: OrderStatus.PENDING },
    });
    if (pendingCount >= this.maxPendingOrders) {
      // Undo dedup key so user can retry after resolving pending orders
      await client.del(dedupKey);
      throw new HttpException(
        `You have ${pendingCount} pending orders. Cancel or wait for them to complete before creating a new one.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 3. Hourly velocity: max orders per rolling hour
    const hourlyKey  = `abuse:orders:hourly:${userId}`;
    const hourlyCount = await this.incrWithTtl(client, hourlyKey, 3600);
    if (hourlyCount > this.maxOrdersPerHour) {
      await client.del(dedupKey);
      throw new HttpException(
        `Order limit reached: maximum ${this.maxOrdersPerHour} orders per hour.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    this.logger.debug(
      `Order creation OK for user=${userId} service=${service} country=${country} pending=${pendingCount} hourly=${hourlyCount}`,
    );
  }

  /**
   * Called before creating a recharge request.
   * Checks max recharge requests per 24-hour rolling window.
   */
  async checkRechargeRequest(userId: string): Promise<void> {
    const client = this.redis.getClient();
    const dailyKey = `abuse:recharge:daily:${userId}`;
    const count = await this.incrWithTtl(client, dailyKey, 86400);
    if (count > this.maxRechargesPerDay) {
      throw new HttpException(
        `Recharge limit reached: maximum ${this.maxRechargesPerDay} requests per day.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Increments a Redis counter and sets its TTL only on first increment
   * (so the window slides from first action, not reset on each action).
   */
  private async incrWithTtl(client: import('ioredis').Redis, key: string, ttlSeconds: number): Promise<number> {
    const count = await client.incr(key);
    if (count === 1) {
      await client.expire(key, ttlSeconds);
    }
    return count;
  }
}
