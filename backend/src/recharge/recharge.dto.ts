import { Transform } from 'class-transformer';
import { IsEnum, IsNumber, IsOptional, IsString, IsUrl, Min } from 'class-validator';

export enum RechargeMethod {
  BINANCE = 'BINANCE',
  USDT    = 'USDT',
  IBAN    = 'IBAN',
  CIH     = 'CIH',
}

export class CreateRechargeDto {
  @IsNumber()
  @Min(1)
  amountUsd: number; // USD — converted to credits (×100) in the service

  // Accept lowercase from Mini App ('binance') or uppercase ('BINANCE')
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsEnum(RechargeMethod)
  method: RechargeMethod;

  @IsOptional()
  @IsString()
  txid?: string;

  @IsOptional()
  @IsUrl()
  proofUrl?: string; // screenshot / payment proof URL
}

export class ReviewRechargeDto {
  @IsEnum(['APPROVED', 'REJECTED'])
  status: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  adminNote?: string;
}
