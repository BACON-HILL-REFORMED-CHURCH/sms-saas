// ============================================================
// OrdersController — SMS activation endpoints
// ============================================================

import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  DefaultValuePipe,
  ParseIntPipe,
  ParseUUIDPipe,
} from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/strategies/jwt.strategy';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  /**
   * POST /api/v1/orders
   * Create a new SMS activation order
   * Body: { service, country, provider? }
   */
  @Post()
  createOrder(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateOrderDto,
  ) {
    return this.ordersService.createOrder(user.sub, dto);
  }

  /**
   * GET /api/v1/orders
   * List user orders with optional status filter + pagination
   */
  @Get()
  listOrders(
    @CurrentUser() user: JwtPayload,
    @Query('page',   new DefaultValuePipe(1),  ParseIntPipe) page: number,
    @Query('limit',  new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: OrderStatus,
  ) {
    return this.ordersService.listOrders(user.sub, page, limit, status);
  }

  /**
   * GET /api/v1/orders/:id
   * Get a single order (polls SMS once on request)
   */
  @Get(':id')
  async getOrder(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    // Trigger a fresh poll on GET so UI gets latest status
    await this.ordersService.pollSms(id);
    return this.ordersService.getOrder(user.sub, id);
  }

  /**
   * DELETE /api/v1/orders/:id
   * Cancel a pending order + trigger refund
   */
  @Delete(':id')
  cancelOrder(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ordersService.cancelOrder(user.sub, id);
  }
}
