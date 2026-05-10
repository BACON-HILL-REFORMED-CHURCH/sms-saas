// ============================================================
// EsimController — user + admin eSIM endpoints
// ============================================================

import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, UseGuards,
  DefaultValuePipe, ParseIntPipe,
} from '@nestjs/common';
import { EsimService } from './esim.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';
import {
  CreateEsimProductDto, UpdateEsimProductDto, AddInventoryDto,
} from './dto/esim.dto';

// ── User routes ──────────────────────────────────────────────

@Controller('esim')
@UseGuards(JwtAuthGuard)
export class EsimController {
  constructor(private readonly esimService: EsimService) {}

  /** GET /api/v1/esim/products — list active products with stock */
  @Get('products')
  listProducts() {
    return this.esimService.listProducts();
  }

  /** POST /api/v1/esim/purchase/:productId — buy eSIM */
  @Post('purchase/:productId')
  purchase(
    @CurrentUser() user: JwtPayload,
    @Param('productId') productId: string,
  ) {
    return this.esimService.purchaseEsim(user.sub, productId);
  }

  /** GET /api/v1/esim/orders — user's eSIM orders */
  @Get('orders')
  listOrders(@CurrentUser() user: JwtPayload) {
    return this.esimService.listUserOrders(user.sub);
  }

  /** GET /api/v1/esim/orders/:id — single order with QR code */
  @Get('orders/:id')
  getOrder(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.esimService.getUserOrder(user.sub, id);
  }
}

// ── Admin routes ─────────────────────────────────────────────

@Controller('admin/esim')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class EsimAdminController {
  constructor(private readonly esimService: EsimService) {}

  /** GET /api/v1/admin/esim/products */
  @Get('products')
  listProducts() {
    return this.esimService.adminListProducts();
  }

  /** POST /api/v1/admin/esim/products */
  @Post('products')
  createProduct(@Body() dto: CreateEsimProductDto) {
    return this.esimService.createProduct(dto);
  }

  /** PATCH /api/v1/admin/esim/products/:id */
  @Patch('products/:id')
  updateProduct(@Param('id') id: string, @Body() dto: UpdateEsimProductDto) {
    return this.esimService.updateProduct(id, dto);
  }

  /** DELETE /api/v1/admin/esim/products/:id */
  @Delete('products/:id')
  deleteProduct(@Param('id') id: string) {
    return this.esimService.deleteProduct(id);
  }

  /** POST /api/v1/admin/esim/inventory — add QR code */
  @Post('inventory')
  addInventory(@Body() dto: AddInventoryDto) {
    return this.esimService.addInventory(dto);
  }

  /** GET /api/v1/admin/esim/inventory/:productId */
  @Get('inventory/:productId')
  listInventory(@Param('productId') productId: string) {
    return this.esimService.listInventory(productId);
  }

  /** DELETE /api/v1/admin/esim/inventory/:id */
  @Delete('inventory/:id')
  deleteInventory(@Param('id') id: string) {
    return this.esimService.deleteInventory(id);
  }

  /** GET /api/v1/admin/esim/orders */
  @Get('orders')
  listOrders(
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.esimService.adminListOrders(page, limit);
  }
}
