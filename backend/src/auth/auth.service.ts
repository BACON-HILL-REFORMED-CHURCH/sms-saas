// ============================================================
// AuthService — register, login, email verification logic
// ============================================================

import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomBytes, createHmac } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { RegisterDto, LoginDto } from './dto/register.dto';

const BCRYPT_ROUNDS = 12; // High enough for security, not too slow

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
  ) {}

  // ── Register ─────────────────────────────────────────────

  async register(dto: RegisterDto) {
    // Check if email already exists
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    // Hash password with bcrypt
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    // Generate a random email verification token
    const verifyToken = randomBytes(32).toString('hex');

    // Create user in DB
    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        passwordHash,
        verifyToken,
      },
    });

    // Send verification email (non-blocking)
    this.mail.sendVerificationEmail(user.email, verifyToken).catch((err) =>
      this.logger.error('Failed to send verification email', err),
    );

    this.logger.log(`New user registered: ${user.email}`);

    return {
      message: 'Registration successful. Please check your email to verify your account.',
      userId: user.id,
    };
  }

  // ── Login ─────────────────────────────────────────────────

  async login(dto: LoginDto) {
    // Find user by email
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user) {
      // Use same error for both "not found" and "wrong password" — prevent enumeration
      throw new UnauthorizedException('Invalid credentials');
    }

    // Verify password
    const passwordMatches = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Optional: require email verification before login
    // if (!user.isEmailVerified) {
    //   throw new UnauthorizedException('Please verify your email first');
    // }

    // Sign JWT
    const payload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = this.jwt.sign(payload);

    this.logger.log(`User logged in: ${user.email}`);

    return {
      accessToken,
      user: this.sanitizeUser(user),
    };
  }

  // ── Email Verification ────────────────────────────────────

  async verifyEmail(token: string) {
    const user = await this.prisma.user.findFirst({
      where: { verifyToken: token },
    });

    if (!user) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    if (user.isEmailVerified) {
      throw new BadRequestException('Email already verified');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        isEmailVerified: true,
        verifyToken: null, // Invalidate token after use
      },
    });

    this.logger.log(`Email verified: ${user.email}`);

    return { message: 'Email verified successfully. You can now log in.' };
  }

  // ── Get current user profile ──────────────────────────────

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    return this.sanitizeUser(user);
  }

  // ── Telegram WebApp Login ─────────────────────────────────

  async telegramWebAppLogin(initData: string) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) throw new UnauthorizedException('Bot not configured');

    // Parse initData
    const params = new URLSearchParams(initData);
    const hash   = params.get('hash');
    if (!hash) throw new UnauthorizedException('Invalid initData: missing hash');

    // Build data_check_string (all params except hash, sorted alphabetically)
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    // Validate signature
    const secretKey    = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (expectedHash !== hash) {
      throw new UnauthorizedException('Invalid initData signature');
    }

    // Parse user info
    const userStr = params.get('user');
    if (!userStr) throw new UnauthorizedException('No user in initData');
    const tgUser = JSON.parse(userStr);
    const telegramId = String(tgUser.id);
    const firstName  = tgUser.first_name ?? '';
    const lastName   = tgUser.last_name  ?? '';
    const username   = tgUser.username   ?? '';

    // Find or create user by telegramId
    let user = await this.prisma.user.findFirst({ where: { telegramId } });

    if (!user) {
      // Create account automatically using Telegram ID as identifier
      const email        = `tg_${telegramId}@telegram.local`;
      const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
      user = await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          telegramId,
          isEmailVerified: true,
          displayName: `${firstName} ${lastName}`.trim() || username || `User${telegramId}`,
        },
      });
      this.logger.log(`New Telegram user: ${telegramId} (@${username})`);
    }

    const payload    = { sub: user.id, email: user.email, role: user.role };
    const accessToken = this.jwt.sign(payload);

    return { accessToken, user: this.sanitizeUser(user) };
  }

  /**
   * Link a Telegram ID to an existing user account.
   * Called by the bot after successful email/password login.
   * If the telegramId is already linked to another account, ignore silently.
   */
  async linkTelegram(userId: string, telegramId: string): Promise<{ ok: boolean; merged?: boolean }> {
    if (!telegramId) return { ok: false };
    const tgId = String(telegramId);

    // Check if another user already owns this telegramId (auto-created tg_ account)
    const existing = await this.prisma.user.findUnique({ where: { telegramId: tgId } });

    if (existing && existing.id !== userId) {
      // Merge: transfer balance from telegram-auto account → real account, then delete tg account
      this.logger.log(`Merging tg account ${existing.id} (${existing.balance} cr) → ${userId}`);
      await this.prisma.$transaction([
        // Transfer balance
        this.prisma.user.update({ where: { id: userId }, data: { balance: { increment: existing.balance } } }),
        // Move transactions to real account
        this.prisma.transaction.updateMany({ where: { userId: existing.id }, data: { userId } }),
        // Delete the auto-created tg account
        this.prisma.user.delete({ where: { id: existing.id } }),
      ]);
    }

    // Now set telegramId on the real account
    await this.prisma.user.update({
      where: { id: userId },
      data: { telegramId: tgId },
    });
    this.logger.log(`Linked telegramId=${tgId} → userId=${userId}`);
    return { ok: true, merged: !!existing };
  }

  // ── Helpers ───────────────────────────────────────────────

  /** Remove sensitive fields before sending to client */
  private sanitizeUser(user: any) {
    const { passwordHash, verifyToken, ...safe } = user;
    return safe;
  }
}
