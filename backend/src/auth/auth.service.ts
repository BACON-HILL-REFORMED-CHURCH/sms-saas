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
import { randomBytes } from 'crypto';
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

  // ── Helpers ───────────────────────────────────────────────

  /** Remove sensitive fields before sending to client */
  private sanitizeUser(user: any) {
    const { passwordHash, verifyToken, ...safe } = user;
    return safe;
  }
}
