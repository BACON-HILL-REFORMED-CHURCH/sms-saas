// ============================================================
// Order DTOs
// ============================================================

import { IsString, IsOptional, IsIn, MinLength } from 'class-validator';

// Supported countries (extend as needed)
const SUPPORTED_COUNTRIES = ['us', 'ru', 'gb', 'de', 'fr', 'ma', 'any'];

export class CreateOrderDto {
  @IsString()
  @MinLength(2)
  service: string;        // e.g. "telegram"

  @IsString()
  @IsIn(SUPPORTED_COUNTRIES, {
    message: `Country must be one of: ${SUPPORTED_COUNTRIES.join(', ')}`,
  })
  country: string;        // e.g. "us"

  @IsOptional()
  @IsString()
  provider?: string;      // e.g. "mock" — if omitted, system picks cheapest
}
