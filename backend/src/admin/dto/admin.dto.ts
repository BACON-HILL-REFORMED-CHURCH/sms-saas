// ============================================================
// Admin DTOs
// ============================================================

import {
  IsString, IsInt, IsOptional, IsEnum,
  IsBoolean, Min, Max, IsUUID,
} from 'class-validator';

export enum AdminUserRole {
  USER  = 'USER',
  ADMIN = 'ADMIN',
}

export class AdminAdjustBalanceDto {
  @IsUUID()
  userId: string;

  @IsInt()
  @Min(-1_000_000)
  @Max(1_000_000)
  amount: number;           // cents — positive=credit, negative=debit

  @IsOptional()
  @IsString()
  reason?: string;
}

export class AdminSetRoleDto {
  @IsUUID()
  userId: string;

  @IsEnum(AdminUserRole)
  role: AdminUserRole;
}

export class AdminSetPricingDto {
  @IsString()
  service: string;

  @IsString()
  country: string;

  @IsString()
  provider: string;

  @IsInt()
  @Min(0)
  @Max(500)
  marginPercent: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
