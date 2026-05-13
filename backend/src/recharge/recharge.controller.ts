import {
  Controller, Post, Get, Patch, Body, Param, UseGuards, Request, Query,
} from '@nestjs/common';
import { RechargeService } from './recharge.service';
import { CreateRechargeDto, ReviewRechargeDto } from './recharge.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('recharge')
@UseGuards(JwtAuthGuard)
export class RechargeController {
  constructor(private readonly recharge: RechargeService) {}

  @Post()
  create(@Request() req: any, @Body() dto: CreateRechargeDto) {
    return this.recharge.createRequest(req.user.sub, dto);
  }

  @Get('my')
  myRequests(@Request() req: any) {
    return this.recharge.getUserRequests(req.user.sub);
  }

  @Get('admin')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  allRequests(@Query('status') status?: string) {
    return this.recharge.getAllRequests(status);
  }

  @Patch('admin/:id/review')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  review(@Param('id') id: string, @Request() req: any, @Body() dto: ReviewRechargeDto) {
    return this.recharge.reviewRequest(id, req.user.sub, dto);
  }
}
