// ============================================================
// OrdersService — SMS activation lifecycle
//
// Flow:
//   1. User calls createOrder()
//   2. We pick provider → call getNumber() → debit balance
//   3. Order stored as PENDING
//   4. Job enqueued to BullMQ for polling (40 retries @ 5s backoff)
//   5. On SMS arrival → update order to RECEIVED
//   6. On cancel/timeout → CANCELED + refund
// ============================================================

import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { OrderStatus, TransactionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderRegistryService } from '../providers/provider-registry.service';
import { WalletService } from '../wallet/wallet.service';
import { SmsQueueService } from '../queue/sms.queue';
import { CreateOrderDto } from './dto/create-order.dto';

// Margin added on top of provider price (loaded from DB/config in production)
const DEFAULT_MARGIN_PERCENT = 30;

// Auto-expire PENDING orders after this many minutes
const ORDER_EXPIRY_MINUTES = 20;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ProviderRegistryService,
    private readonly wallet: WalletService,
    private readonly smsQueue: SmsQueueService,
  ) {}

  // ── Create order ──────────────────────────────────────────

  async createOrder(userId: string, dto: CreateOrderDto) {
    // 1. Pick provider
    const provider = dto.provider
      ? this.registry.get(dto.provider)
      : await this.registry.getBest(dto.service, dto.country);

    // 2. Get number from provider
    let providerNumber;
    try {
      providerNumber = await provider.getNumber(dto.service, dto.country);
    } catch (err) {
      throw new BadRequestException(`Provider error: ${err.message}`);
    }

    // 3. Calculate price with margin
    const price = this.applyMargin(providerNumber.cost, DEFAULT_MARGIN_PERCENT);

    // 4. Debit user balance atomically (throws if insufficient)
    await this.wallet.atomicDebit(
      userId,
      price,
      `SMS activation — ${dto.service} (${providerNumber.phoneNumber})`,
    );

    // 5. Persist order to DB
    const order = await this.prisma.order.create({
      data: {
        userId,
        provider: provider.name,
        externalId: providerNumber.externalId,
        phoneNumber: providerNumber.phoneNumber,
        service: dto.service,
        country: dto.country,
        status: OrderStatus.PENDING,
        price,
      },
    });

    // 6. Enqueue SMS polling job
    await this.smsQueue.addPollJob(order.id);

    // 7. Link debit transaction to order
    await this.prisma.transaction.updateMany({
      where: {
        userId,
        orderId: null,
        type: 'DEBIT',
        description: { contains: providerNumber.phoneNumber },
      },
      data: { orderId: order.id },
    });

    this.logger.log(
      `Order created: id=${order.id} user=${userId} service=${dto.service} number=${providerNumber.phoneNumber}`,
    );

    return order;
  }

  // ── Poll SMS for a single order ───────────────────────────

  async pollSms(orderId: string): Promise<{ received: boolean }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.status !== OrderStatus.PENDING) {
      return { received: false };
    }

    const provider = this.registry.get(order.provider);

    try {
      const smsResult = await provider.getSMS(order.externalId);

      if (smsResult.code) {
        // ✅ SMS received — update order
        await this.prisma.order.update({
          where: { id: orderId },
          data: {
            status: OrderStatus.RECEIVED,
            smsCode: smsResult.code,
            smsFullText: smsResult.fullText,
          },
        });
        this.logger.log(`SMS received for order ${orderId}: code=${smsResult.code}`);
        return { received: true };
      }
    } catch (err) {
      this.logger.warn(`Poll error for order ${orderId}: ${err.message}`);
    }

    return { received: false };
  }

  // ── Cancel order ──────────────────────────────────────────

  async cancelOrder(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });

    if (!order) throw new NotFoundException('Order not found');
    if (order.userId !== userId) throw new BadRequestException('Not your order');
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException(`Cannot cancel order with status: ${order.status}`);
    }

    // Cancel on provider side
    const provider = this.registry.get(order.provider);
    try {
      await provider.cancel(order.externalId);
    } catch (err) {
      this.logger.warn(`Provider cancel failed for ${orderId}: ${err.message}`);
    }

    // Update order status
    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELED },
    });

    // Refund user
    await this.wallet.atomicCredit(
      userId,
      order.price,
      TransactionType.REFUND,
      `Refund — canceled order (${order.service} ${order.phoneNumber})`,
      orderId,
    );

    this.logger.log(`Order ${orderId} canceled + refunded ${order.price}¢ to user ${userId}`);

    return { message: 'Order canceled and refunded successfully' };
  }

  // ── Get single order ──────────────────────────────────────

  async getOrder(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.userId !== userId) throw new NotFoundException('Order not found');
    return order;
  }

  // ── List user orders ──────────────────────────────────────

  async listOrders(userId: string, page = 1, limit = 20, status?: OrderStatus) {
    const skip = (page - 1) * limit;
    const where: any = { userId };
    if (status) where.status = status;

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      orders,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ── Expire old pending orders (runs via @Cron in OrdersModule) ──

  async expireOldOrders() {
    const cutoff = new Date(Date.now() - ORDER_EXPIRY_MINUTES * 60 * 1_000);

    const expired = await this.prisma.order.findMany({
      where: { status: OrderStatus.PENDING, createdAt: { lt: cutoff } },
    });

    for (const order of expired) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.EXPIRED },
      });

      // Refund for expired orders
      await this.wallet.atomicCredit(
        order.userId,
        order.price,
        TransactionType.REFUND,
        `Refund — expired order (${order.service})`,
        order.id,
      );

      this.logger.log(`Order ${order.id} expired + refunded`);
    }

    return expired.length;
  }

  // ── Helpers ───────────────────────────────────────────────

  private applyMargin(baseCost: number, marginPercent: number): number {
    return Math.ceil(baseCost * (1 + marginPercent / 100));
  }
}
