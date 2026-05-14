// ============================================================
// WalletService — atomic balance operations
//
// ⚠️  All balance mutations go through Prisma transactions to
//     prevent race conditions under concurrent requests.
// ============================================================

import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { TransactionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { DepositDto, DepositMethod, AdminAdjustDto } from './dto/wallet.dto';

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ── Get balance ───────────────────────────────────────────

  async getBalance(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { balance: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return { balance: user.balance, balanceFormatted: this.formatCents(user.balance) };
  }

  // ── Deposit ───────────────────────────────────────────────

  async deposit(userId: string, dto: DepositDto) {
    // For crypto_mock: simulate payment confirmation delay
    if (dto.method === DepositMethod.CRYPTO_MOCK) {
      await this.simulateCryptoPayment(dto.amount);
    }

    const result = await this.atomicCredit(
      userId,
      dto.amount,
      TransactionType.DEPOSIT,
      `Deposit via ${dto.method} — ${this.formatCents(dto.amount)}`,
    );

    this.logger.log(
      `Deposit: user=${userId} amount=${dto.amount} method=${dto.method}`,
    );

    return {
      message: 'Deposit successful',
      transaction: result.transaction,
      newBalance: result.newBalance,
      newBalanceFormatted: this.formatCents(result.newBalance),
    };
  }

  // ── Transaction history ───────────────────────────────────

  async getHistory(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          order: {
            select: { service: true, phoneNumber: true },
          },
        },
      }),
      this.prisma.transaction.count({ where: { userId } }),
    ]);

    return {
      transactions: transactions.map((t) => ({
        ...t,
        amountFormatted: this.formatCents(Math.abs(t.amount)),
        balanceAfterFormatted: this.formatCents(t.balanceAfter),
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ── Core atomic operations (used internally by OrdersService) ──

  /**
   * Debit user balance atomically.
   * Throws if balance insufficient.
   */
  async atomicDebit(
    userId: string,
    amount: number,
    description: string,
    orderId?: string,
  ) {
    return this.redis.withLock(`wallet:${userId}`, 10, () => this.prisma.$transaction(async (tx) => {
      // Lock + fetch current balance
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, balance: true },
      });

      if (user.balance < amount) {
        throw new BadRequestException(
          `Insufficient balance. Have ${this.formatCents(user.balance)}, need ${this.formatCents(amount)}`,
        );
      }

      const newBalance = user.balance - amount;

      // Update balance
      await tx.user.update({
        where: { id: userId },
        data: { balance: newBalance },
      });

      // Record transaction
      const transaction = await tx.transaction.create({
        data: {
          userId,
          type: TransactionType.DEBIT,
          amount: -amount, // negative = debit
          balanceAfter: newBalance,
          description,
          orderId: orderId ?? null,
        },
      });

      return { transaction, newBalance };
    }));
  }

  /**
   * Credit user balance atomically (deposit or refund).
   */
  async atomicCredit(
    userId: string,
    amount: number,
    type: TransactionType,
    description: string,
    orderId?: string,
  ) {
    return this.redis.withLock(`wallet:${userId}`, 10, () => this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, balance: true },
      });

      const newBalance = user.balance + amount;

      await tx.user.update({
        where: { id: userId },
        data: { balance: newBalance },
      });

      const transaction = await tx.transaction.create({
        data: {
          userId,
          type,
          amount: +amount, // positive = credit
          balanceAfter: newBalance,
          description,
          orderId: orderId ?? null,
        },
      });

      return { transaction, newBalance };
    }));
  }

  /**
   * Admin manual adjustment (can be positive or negative).
   */
  async adminAdjust(dto: AdminAdjustDto, adminId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!user) throw new NotFoundException('User not found');

    const isCredit = dto.amount > 0;
    const absAmount = Math.abs(dto.amount);

    const result = isCredit
      ? await this.atomicCredit(
          dto.userId,
          absAmount,
          TransactionType.ADMIN_ADJ,
          dto.reason ?? `Admin adjustment by ${adminId}`,
        )
      : await this.atomicDebit(
          dto.userId,
          absAmount,
          dto.reason ?? `Admin adjustment by ${adminId}`,
        );

    this.logger.warn(
      `Admin ${adminId} adjusted user ${dto.userId} by ${dto.amount} cents`,
    );

    return {
      message: 'Balance adjusted',
      newBalance: result.newBalance,
      newBalanceFormatted: this.formatCents(result.newBalance),
    };
  }

  // ── Helpers ───────────────────────────────────────────────

  /**
   * Check if a crypto payment UUID has already been credited.
   * Prevents double-crediting on repeated check calls.
   */
  async isCryptoAlreadyCredited(uuid: string): Promise<boolean> {
    const existing = await this.prisma.transaction.findFirst({
      where: {
        description: { contains: uuid },
        type: 'DEPOSIT',
      },
    });
    return !!existing;
  }

  /** Convert cents to "$X.XX" string */
  formatCents(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }

  /** Mock crypto payment — simulates async confirmation */
  private async simulateCryptoPayment(amount: number): Promise<void> {
    // In production: verify actual blockchain transaction here
    await new Promise((r) => setTimeout(r, 500));
    this.logger.log(`[MOCK] Crypto payment confirmed: ${this.formatCents(amount)}`);
  }
}
