import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { RedisService } from '../redis/redis.service';
import { CreateRechargeDto, ReviewRechargeDto } from './recharge.dto';
import { TransactionType } from '@prisma/client';

@Injectable()
export class RechargeService {
  private readonly logger = new Logger(RechargeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly redis: RedisService,
  ) {}

  async createRequest(userId: string, dto: CreateRechargeDto) {
    // Check duplicate txid
    if (dto.txid) {
      const existing = await this.prisma.rechargeRequest.findUnique({
        where: { txid: dto.txid },
      });
      if (existing) throw new BadRequestException('Transaction ID already used');
    }

    // Check duplicate screenshot
    if (dto.screenshotHash) {
      const existing = await this.prisma.rechargeRequest.findUnique({
        where: { screenshotHash: dto.screenshotHash },
      });
      if (existing) throw new BadRequestException('Screenshot already used');
    }

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    const request = await this.prisma.rechargeRequest.create({
      data: {
        userId,
        amount: dto.amount,
        method: dto.method,
        txid: dto.txid,
        screenshot: dto.screenshot,
        screenshotHash: dto.screenshotHash,
        expiresAt,
      },
    });

    this.logger.log(`Recharge request created: ${request.id} user=${userId}`);
    return request;
  }

  async getUserRequests(userId: string) {
    return this.prisma.rechargeRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getAllRequests(status?: string) {
    return this.prisma.rechargeRequest.findMany({
      where: status ? { status: status as any } : {},
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true, displayName: true } } },
    });
  }

  async reviewRequest(id: string, adminId: string, dto: ReviewRechargeDto) {
    return this.redis.withLock(`recharge:${id}`, 10, async () => {
      const request = await this.prisma.rechargeRequest.findUnique({
        where: { id },
      });
      if (!request) throw new NotFoundException('Request not found');
      if (request.status !== 'PENDING') {
        throw new BadRequestException('Request already reviewed');
      }

      await this.prisma.rechargeRequest.update({
        where: { id },
        data: {
          status: dto.status,
          adminNote: dto.adminNote,
          reviewedBy: adminId,
        },
      });

      if (dto.status === 'APPROVED') {
        await this.wallet.atomicCredit(
          request.userId,
          request.amount,
          TransactionType.DEPOSIT,
          `Recharge approved — ${request.method} — by admin`,
        );
        this.logger.log(`Recharge approved: ${id} +${request.amount} → user ${request.userId}`);
      }

      return { message: `Request ${dto.status.toLowerCase()}` };
    });
  }

  async expireOldRequests() {
    const result = await this.prisma.rechargeRequest.updateMany({
      where: {
        status: 'PENDING',
        expiresAt: { lt: new Date() },
      },
      data: { status: 'EXPIRED' },
    });
    if (result.count > 0) {
      this.logger.log(`Expired ${result.count} recharge requests`);
    }
  }
}
