import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Inject, Logger, forwardRef } from '@nestjs/common';
import { OrdersService } from '../orders/orders.service';
import { SMS_QUEUE, POLL_SMS_JOB, EXPIRE_ORDERS_JOB } from './sms.queue';

@Processor(SMS_QUEUE)
export class SmsProcessor extends WorkerHost {
  private readonly logger = new Logger(SmsProcessor.name);

  constructor(
    @Inject(forwardRef(() => OrdersService))
    private readonly orders: OrdersService,
  ) {
    super();
  }

  async process(job: Job) {
    if (job.name === POLL_SMS_JOB) {
      const { orderId } = job.data;
      const result = await this.orders.pollSms(orderId);
      if (result.received) {
        this.logger.log(`✅ SMS received for order ${orderId}`);
        return { done: true };
      }
      throw new Error('SMS not yet received — retry');
    }

    if (job.name === EXPIRE_ORDERS_JOB) {
      const count = await this.orders.expireOldOrders();
      this.logger.log(`⏰ Expired ${count} orders`);
    }
  }
}
