import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

// Open after this many failures within WINDOW_SECONDS
const FAILURE_THRESHOLD = 5;
// Rolling window for counting failures
const WINDOW_SECONDS    = 60;
// How long to stay OPEN before allowing a probe (HALF_OPEN)
const RESET_TIMEOUT     = 30;

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Execute fn() through the circuit breaker for the named provider.
   * Throws immediately if the circuit is OPEN without calling fn().
   */
  async execute<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (!(await this.isHealthy(name))) {
      throw new Error(`Circuit OPEN for provider "${name}" — skipping`);
    }

    try {
      const result = await fn();
      await this.recordSuccess(name);
      return result;
    } catch (err) {
      await this.recordFailure(name);
      throw err;
    }
  }

  /**
   * True when the circuit is CLOSED or HALF_OPEN (probe allowed).
   * False when explicitly OPEN in Redis.
   */
  async isHealthy(name: string): Promise<boolean> {
    return !(await this.redis.exists(`cb:${name}:open`));
  }

  /**
   * Current state for monitoring.
   * HALF_OPEN = open key expired but failures still present → probing.
   */
  async getState(name: string): Promise<CircuitState> {
    const isOpen = await this.redis.exists(`cb:${name}:open`);
    if (isOpen) return 'OPEN';

    const failures = await this.redis.get<number>(`cb:${name}:failures`);
    if (failures && failures >= 1) return 'HALF_OPEN';

    return 'CLOSED';
  }

  private async recordSuccess(name: string): Promise<void> {
    const client = this.redis.getClient();
    // Clear failure counter — circuit is healthy again
    await client.del(`cb:${name}:failures`);
    // `open` key already expired (we're in HALF_OPEN probe) — nothing else to do
    this.logger.log(`✅ Circuit CLOSED for provider "${name}"`);
  }

  private async recordFailure(name: string): Promise<void> {
    const client = this.redis.getClient();
    const failKey = `cb:${name}:failures`;

    const count = await client.incr(failKey);
    // Set expiry only on the first increment (sliding window)
    if (count === 1) await client.expire(failKey, WINDOW_SECONDS);

    this.logger.warn(`Provider "${name}" failure ${count}/${FAILURE_THRESHOLD}`);

    if (count >= FAILURE_THRESHOLD) {
      // NX: don't reset TTL if already open (so the 30s starts from first trip)
      const opened = await client.set(`cb:${name}:open`, '1', 'EX', RESET_TIMEOUT, 'NX');
      if (opened) {
        this.logger.error(`🔴 Circuit OPENED for provider "${name}" — will probe in ${RESET_TIMEOUT}s`);
      }
    }
  }
}
