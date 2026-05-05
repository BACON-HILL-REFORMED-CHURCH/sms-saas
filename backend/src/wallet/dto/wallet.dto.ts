// ============================================================
// Wallet DTOs — validated input shapes
// ============================================================

import { IsInt, IsEnum, Min, Max, IsOptional, IsString } from 'class-validator';

export enum DepositMethod {
  MANUAL       = 'manual',
  CRYPTO_MOCK  = 'crypto_mock',
}

export class DepositDto {
  @IsInt({ message: 'Amount must be an integer (in cents)' })
  @Min(100,   { message: 'Minimum deposit is $1.00 (100 cents)' })
  @Max(1_000_000, { message: 'Maximum deposit is $10,000' })
  amount: number; // in cents

  @IsEnum(DepositMethod)
  method: DepositMethod;
}

export class AdminAdjustDto {
  @IsString()
  userId: string;

  @IsInt()
  amount: number; // positive = credit, negative = debit

  @IsOptional()
  @IsString()
  reason?: string;
}
