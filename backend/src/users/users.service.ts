// ============================================================
// UsersService — user lookup and management
// ============================================================

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  }

  /** Returns sanitized user (no passwordHash, no verifyToken) */
  async getPublicProfile(id: string) {
    const user = await this.findById(id);
    const { passwordHash, verifyToken, ...safe } = user;
    return safe;
  }

  async listAll(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          role: true,
          balance: true,
          isEmailVerified: true,
          createdAt: true,
        },
      }),
      this.prisma.user.count(),
    ]);
    return { users, total, page, limit };
  }
}
