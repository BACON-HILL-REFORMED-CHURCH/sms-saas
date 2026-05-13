import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';

export const SMS_QUEUE = 'sms-polling';
export const POLL_SMS_JOB = 'poll-sms';
export const EXPIRE_ORDERS_JOB = 'expire-orders';

@Injectable()
export class SmsQueueService {
  constructor(
    @InjectQueue(SMS_QUEUE) private readonly queue: Queue,
  ) {}

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
