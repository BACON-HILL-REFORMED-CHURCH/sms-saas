// ============================================================
// AdminService — platform management operations
// ============================================================

import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import {
  AdminAdjustBalanceDto,
  AdminSetRoleDto,
  AdminSetPricingDto,
} from './dto/admin.dto';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
  ) {}

  // ── Users ─────────────────────────────────────────────────

  async listUsers(page = 1, limit = 25, search?: string) {
    const skip = (page - 1) * limit;
    const where = search
      ? { email: { contains: search, mode: 'insensitive' as const } }
      : {};

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, email: true, role: true,
          balance: true, isEmailVerified: true, createdAt: true,
          _count: { select: { orders: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      users: users.map((u) => ({
        ...u,
        balanceFormatted: this.wallet.formatCents(u.balance),
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, email: true, role: true, balance: true,
        isEmailVerified: true, createdAt: true,
        orders: { orderBy: { createdAt: 'desc' }, take: 10 },
        transactions: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  // ── Balance adjustment ────────────────────────────────────

  async adjustBalance(dto: AdminAdjustBalanceDto, adminId: string) {
    const result = await this.wallet.adminAdjust(dto, adminId);

    // Write to audit log
    await this.writeAuditLog(adminId, 'ADMIN_BALANCE_ADJUST', {
      targetUserId: dto.userId,
      amount: dto.amount,
      reason: dto.reason,
      newBalance: result.newBalance,
    });

    this.logger.warn(
      `Admin ${adminId} adjusted user ${dto.userId}: ${dto.amount > 0 ? '+' : ''}${dto.amount}¢`,
    );

    return result;
  }

  // ── Role management ───────────────────────────────────────

  async setRole(dto: AdminSetRoleDto, adminId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!user) throw new NotFoundException('User not found');

    const updated = await this.prisma.user.update({
      where: { id: dto.userId },
      data: { role: dto.role },
      select: { id: true, email: true, role: true },
    });

    await this.writeAuditLog(adminId, 'ADMIN_SET_ROLE', {
      targetUserId: dto.userId,
      newRole: dto.role,
    });

    this.logger.warn(`Admin ${adminId} set role of ${dto.userId} to ${dto.role}`);
    return updated;
  }

  // ── Pricing / margin ──────────────────────────────────────

  async setPricing(dto: AdminSetPricingDto, adminId: string) {
    const pricing = await this.prisma.servicePricing.upsert({
      where: {
        service_country_provider: {
          service: dto.service,
          country: dto.country,
          provider: dto.provider,
        },
      },
      update: {
        marginPercent: dto.marginPercent,
        isActive: dto.isActive ?? true,
      },
      create: {
        service: dto.service,
        country: dto.country,
        provider: dto.provider,
        marginPercent: dto.marginPercent,
        isActive: dto.isActive ?? true,
      },
    });

    await this.writeAuditLog(adminId, 'ADMIN_SET_PRICING', { ...dto });
    return pricing;
  }

  async listPricing() {
    return this.prisma.servicePricing.findMany({
      orderBy: [{ service: 'asc' }, { country: 'asc' }],
    });
  }

  // ── Audit logs ────────────────────────────────────────────

  async getLogs(page = 1, limit = 50, userId?: string) {
    const skip = (page - 1) * limit;
    const where = userId ? { userId } : {};

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { logs, meta: { page, limit, total } };
  }

  // ── Platform stats ────────────────────────────────────────

  async getStats() {
    const [
      totalUsers,
      totalOrders,
      pendingOrders,
      revenueResult,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.order.count(),
      this.prisma.order.count({ where: { status: 'PENDING' } }),
      this.prisma.transaction.aggregate({
        where: { type: 'DEBIT' },
        _sum: { amount: true },
      }),
    ]);

    const totalRevenue = Math.abs(revenueResult._sum.amount ?? 0);

    return {
      totalUsers,
      totalOrders,
      pendingOrders,
      totalRevenue,
      totalRevenueFormatted: this.wallet.formatCents(totalRevenue),
    };
  }

  // ── Helpers ───────────────────────────────────────────────

  private async writeAuditLog(
    userId: string,
    action: string,
    details: Record<string, any>,
  ) {
    await this.prisma.auditLog.create({
      data: { userId, action, details },
    });
  }
}
