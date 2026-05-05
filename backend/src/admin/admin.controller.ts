// ============================================================
// AdminController — all routes protected by ADMIN role
// ============================================================

import {
  Controller, Get, Post, Patch, Body,
  Param, Query, UseGuards,
  DefaultValuePipe, ParseIntPipe, ParseUUIDPipe,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import {
  AdminAdjustBalanceDto,
  AdminSetRoleDto,
  AdminSetPricingDto,
} from './dto/admin.dto';

// All routes in this controller require JWT + ADMIN role
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ── Stats ────────────────────────────────────────────────

  /** GET /api/v1/admin/stats */
  @Get('stats')
  getStats() {
    return this.adminService.getStats();
  }

  // ── Users ────────────────────────────────────────────────

  /** GET /api/v1/admin/users?page=1&limit=25&search=email */
  @Get('users')
  listUsers(
    @Query('page',   new DefaultValuePipe(1),  ParseIntPipe) page: number,
    @Query('limit',  new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Query('search') search?: string,
  ) {
    return this.adminService.listUsers(page, limit, search);
  }

  /** GET /api/v1/admin/users/:id */
  @Get('users/:id')
  getUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.getUser(id);
  }

  /** PATCH /api/v1/admin/users/role */
  @Patch('users/role')
  setRole(
    @Body() dto: AdminSetRoleDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.adminService.setRole(dto, admin.sub);
  }

  // ── Balance ──────────────────────────────────────────────

  /** POST /api/v1/admin/balance/adjust */
  @Post('balance/adjust')
  adjustBalance(
    @Body() dto: AdminAdjustBalanceDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.adminService.adjustBalance(dto, admin.sub);
  }

  // ── Pricing ──────────────────────────────────────────────

  /** GET /api/v1/admin/pricing */
  @Get('pricing')
  listPricing() {
    return this.adminService.listPricing();
  }

  /** POST /api/v1/admin/pricing */
  @Post('pricing')
  setPricing(
    @Body() dto: AdminSetPricingDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.adminService.setPricing(dto, admin.sub);
  }

  // ── Audit logs ───────────────────────────────────────────

  /** GET /api/v1/admin/logs?page=1&userId=xxx */
  @Get('logs')
  getLogs(
    @Query('page',   new DefaultValuePipe(1),  ParseIntPipe) page: number,
    @Query('limit',  new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('userId') userId?: string,
  ) {
    return this.adminService.getLogs(page, limit, userId);
  }
}
