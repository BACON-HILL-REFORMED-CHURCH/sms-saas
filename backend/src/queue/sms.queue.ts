import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

export const SMS_QUEUE = 'sms-polling';
export const POLL_SMS_JOB = 'poll-sms';
export const EXPIRE_ORDERS_JOB = 'expire-orders';

@Injectable()
export class SmsQueueService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SmsQueueService.name);

  constructor(
    @InjectQueue(SMS_QUEUE) private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap() {
    await this.queue.add(
      EXPIRE_ORDERS_JOB,
      {},
      {
        repeat: { every: 60_000 },
        removeOnComplete: { count: 1 },
        removeOnFail: { count: 50 },
      },
    );
    this.logger.log('Order expiry repeatable job scheduled (every 60s)');
  }

  async addPollJob(orderId: string) {
    await this.queue.add(
      POLL_SMS_JOB,
      { orderId },
      {
        attempts: 40,
        backoff: { type: 'fixed', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }
}
