// ============================================================
// AuthController — public auth endpoints
// ============================================================

import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto, VerifyEmailDto } from './dto/register.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * POST /api/v1/auth/register
   * Body: { email, password }
   */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60_000, limit: 5 } }) // 5 registrations/min per IP
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  /**
   * POST /api/v1/auth/login
   * Body: { email, password }
   * Returns: { accessToken, user }
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } }) // 10 login attempts/min per IP
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  /**
   * GET /api/v1/auth/verify-email?token=xxx
   */
  @Get('verify-email')
  verifyEmail(@Query() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto.token);
  }

  /**
   * POST /api/v1/auth/telegram-webapp
   * Body: { initData: string }
   */
  @Post('telegram-webapp')
  @HttpCode(HttpStatus.OK)
  telegramWebApp(@Body('initData') initData: string) {
    return this.authService.telegramWebAppLogin(initData);
  }

  /**
   * PATCH /api/v1/auth/link-telegram
   * Body: { telegramId: string }
   * Links a Telegram account to the logged-in user — called by bot after login
   */
  @Patch('link-telegram')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  linkTelegram(@Request() req: any, @Body('telegramId') telegramId: string) {
    return this.authService.linkTelegram(req.user.sub, telegramId);
  }

  /**
   * GET /api/v1/auth/me
   * Protected — requires valid JWT
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  getProfile(@Request() req: any) {
    return this.authService.getProfile(req.user.sub);
  }
}
