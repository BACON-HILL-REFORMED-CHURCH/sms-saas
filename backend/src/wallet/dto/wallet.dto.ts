// ============================================================
// Wallet DTOs — validated input shapes
// ============================================================

import { IsInt, IsNumber, IsEnum, Min, Max, IsOptional, IsString } from 'class-validator';

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

export class CryptoDepositDto {
  @IsNumber({}, { message: 'Amount must be a number in USD (e.g. 10 = $10.00)' })
  @Min(1,      { message: 'Minimum deposit is $1.00' })
  @Max(10_000, { message: 'Maximum deposit is $10,000' })
  amountUsd: number; // in USD dollars (e.g. 10 = $10.00)
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
