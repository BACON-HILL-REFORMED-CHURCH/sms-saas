// ============================================================
// RedisService — typed wrapper around ioredis
// ============================================================

import { Injectable, Inject, OnModuleInit, OnModuleDestroy, Logger, ConflictException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;

  constructor(@Inject('REDIS_OPTIONS') private readonly options: any) {}

  onModuleInit() {
    this.client = new Redis(this.options);
    this.client.on('connect', () => this.logger.log('✅ Redis connected'));
    this.client.on('error', (err) => this.logger.error('Redis error', err));
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  // ── Cache helpers ────────────────────────────────────────

  async get<T>(key: string): Promise<T | null> {
    const val = await this.client.get(key);
    return val ? (JSON.parse(val) as T) : null;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlSeconds) {
      await this.client.set(key, serialized, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, serialized);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  // ── Distributed locking ──────────────────────────────────

  /**
   * Acquire a Redis lock, run fn(), then release atomically.
   * Throws 409 ConflictException if the lock is already held.
   *
   * Key convention: pass the semantic key without the "lock:" prefix,
   * e.g. "wallet:userId" or "order:orderId".
   */
  async withLock<T>(
    key: string,
    ttlSeconds: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lockKey = `lock:${key}`;
    const token = randomUUID();

    const acquired = await this.client.set(lockKey, token, 'EX', ttlSeconds, 'NX');
    if (!acquired) {
      throw new ConflictException(`Resource is busy, please retry (${key})`);
    }

    try {
      return await fn();
    } finally {
      // Lua: only delete the key if we still own it
      await this.client.eval(
        `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`,
        1,
        lockKey,
        token,
      );
    }
  }

  // ── Pub/Sub (for future use) ─────────────────────────────

  getClient(): Redis {
    return this.client;
  }
}
