import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { RedisService } from '../redis/redis.service';
import { AbuseService } from '../abuse/abuse.service';
import { CreateRechargeDto, ReviewRechargeDto } from './recharge.dto';
import { TransactionType } from '@prisma/client';

const CREDITS_PER_USD = 100;

@Injectable()
export class RechargeService {
  private readonly logger = new Logger(RechargeService.name);
  private readonly botToken: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly redis: RedisService,
    private readonly abuse: AbuseService,
    private readonly config: ConfigService,
  ) {
    this.botToken = config.get<string>('TELEGRAM_BOT_TOKEN', '');
  }

  // ── Create ─────────────────────────────────────────────────────

  async createRequest(userId: string, dto: CreateRechargeDto) {
    await this.abuse.checkRechargeRequest(userId);

    if (dto.txid) {
      const dup = await this.prisma.rechargeRequest.findUnique({ where: { txid: dto.txid } });
      if (dup) throw new BadRequestException('Transaction ID already used');
    }

    const credits    = Math.round(dto.amountUsd * CREDITS_PER_USD);
    const expiresAt  = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const request = await this.prisma.rechargeRequest.create({
      data: {
        userId,
        amount:    credits,
        method:    dto.method,
        txid:      dto.txid,
        screenshot: dto.proofUrl,
        expiresAt,
      },
    });

    this.logger.log(`Recharge request: ${request.id} $${dto.amountUsd} (${credits} cr) user=${userId}`);
    return request;
  }

  // ── User queries ───────────────────────────────────────────────

  async getUserRequests(userId: string) {
    const rows = await this.prisma.rechargeRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    // Return amountUsd alongside credits for the Mini App
    return rows.map(r => ({ ...r, amountUsd: r.amount / CREDITS_PER_USD }));
  }

  // ── Admin queries ──────────────────────────────────────────────

  async getAllRequests(status?: string) {
    const rows = await this.prisma.rechargeRequest.findMany({
      where: status ? { status: status as any } : {},
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true, displayName: true, telegramId: true } } },
    });
    return rows.map(r => ({ ...r, amountUsd: r.amount / CREDITS_PER_USD }));
  }

  // ── Review (approve / reject) ──────────────────────────────────

  async reviewRequest(id: string, adminId: string, dto: ReviewRechargeDto) {
    return this.redis.withLock(`recharge:${id}`, 10, async () => {
      const request = await this.prisma.rechargeRequest.findUnique({
        where: { id },
        include: { user: { select: { telegramId: true } } },
      });
      if (!request) throw new NotFoundException('Request not found');
      if (request.status !== 'PENDING') {
        throw new BadRequestException('Request already reviewed');
      }

      await this.prisma.rechargeRequest.update({
        where: { id },
        data: { status: dto.status, adminNote: dto.adminNote, reviewedBy: adminId },
      });

      const amountUsd = (request.amount / CREDITS_PER_USD).toFixed(2);

      if (dto.status === 'APPROVED') {
        await this.wallet.atomicCredit(
          request.userId,
          request.amount,
          TransactionType.DEPOSIT,
          `Recharge approved — ${request.method}`,
        );
        this.logger.log(`Recharge approved: ${id} +${request.amount} cr → user ${request.userId}`);

        await this.notifyUser(
          request.user.telegramId,
          `✅ *Recharge Approved*\n\n` +
          `Your deposit of *$${amountUsd}* has been confirmed.\n` +
          `💎 *+${request.amount} credits* added to your balance!`,
        );
      } else {
        this.logger.log(`Recharge rejected: ${id} user=${request.userId}`);

        await this.notifyUser(
          request.user.telegramId,
          `❌ *Recharge Rejected*\n\n` +
          `Your deposit request of *$${amountUsd}* was not approved.` +
          (dto.adminNote ? `\n\nReason: ${dto.adminNote}` : '') +
          `\n\nContact support if you believe this is an error.`,
        );
      }

      return { message: `Request ${dto.status.toLowerCase()}`, credits: request.amount };
    });
  }

  // ── Expiry cron (every hour) ───────────────────────────────────

  @Cron(CronExpression.EVERY_HOUR)
  async expireOldRequests() {
    const result = await this.prisma.rechargeRequest.updateMany({
      where: { status: 'PENDING', expiresAt: { lt: new Date() } },
      data:  { status: 'EXPIRED' },
    });
    if (result.count > 0) {
      this.logger.log(`Expired ${result.count} recharge request(s)`);
    }
  }

  // ── Telegram notification helper ───────────────────────────────

  private async notifyUser(telegramId: string | null, text: string) {
    if (!telegramId || !this.botToken) return;
    try {
      await axios.post(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        { chat_id: telegramId, text, parse_mode: 'Markdown' },
        { timeout: 5_000 },
      );
    } catch (err) {
      this.logger.warn(`Telegram notify failed for ${telegramId}: ${err?.message}`);
    }
  }
}
