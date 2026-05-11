// ============================================================
// Order DTOs
// ============================================================

import { IsString, IsOptional, MinLength, MaxLength, Matches } from 'class-validator';

export class CreateOrderDto {
  @IsString()
  @MinLength(1)
  service: string;        // e.g. "telegram" or SMSpool short_name

  @IsString()
  @MinLength(2)
  @MaxLength(10)
  @Matches(/^[a-z0-9_-]+$/i, { message: 'Invalid country code' })
  country: string;        // e.g. "us" or any provider country code

  @IsOptional()
  @IsString()
  provider?: string;      // e.g. "mock" — if omitted, system picks cheapest
}
