// ============================================================
// SmsPollingService — background job that polls pending orders
//
// Every 5 seconds, polls all PENDING orders for incoming SMS.
// Uses NestJS @Cron via ScheduleModule (already registered in AppModule).
//
// Design: simple cron approach — scales well up to ~500 concurrent
// orders. For higher scale, replace with BullMQ job queue + Redis.
// ============================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from './orders.service';
import { OrderStatus } from '@prisma/client';

@Injectable()
export class SmsPollingService {
  private readonly logger = new Logger(SmsPollingService.name);
  private isPolling = false; // Prevent overlapping runs

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {}

  // ── Poll every 5 seconds ──────────────────────────────────

  @Cron(CronExpression.EVERY_5_SECONDS)
  async pollPendingOrders() {
    // Skip if previous run is still going
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      // Fetch all PENDING orders
      const pending = await this.prisma.order.findMany({
        where: { status: OrderStatus.PENDING },
        select: { id: true },
      });

      if (pending.length === 0) return;

      this.logger.debug(`Polling ${pending.length} pending order(s)…`);

      // Poll all orders concurrently (with concurrency cap)
      const results = await Promise.allSettled(
        pending.map((o) => this.orders.pollSms(o.id)),
      );

      const received = results.filter(
        (r) => r.status === 'fulfilled' && r.value.received,
      ).length;

      if (received > 0) {
        this.logger.log(`📲 ${received}/${pending.length} orders received SMS`);
      }
    } catch (err) {
      this.logger.error('Polling error', err);
    } finally {
      this.isPolling = false;
    }
  }

  // ── Expire stale orders every minute ─────────────────────

  @Cron(CronExpression.EVERY_MINUTE)
  async expireStaleOrders() {
    const count = await this.orders.expireOldOrders();
    if (count > 0) {
      this.logger.log(`⏰ Expired ${count} stale order(s)`);
    }
  }
}
