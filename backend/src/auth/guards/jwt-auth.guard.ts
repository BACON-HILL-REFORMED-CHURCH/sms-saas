// ============================================================
// JwtAuthGuard — protects routes requiring authentication
// Usage: @UseGuards(JwtAuthGuard)
// ============================================================

import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
