import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

export enum RechargeMethod {
  BINANCE = 'BINANCE',
  USDT = 'USDT',
  IBAN = 'IBAN',
  CIH = 'CIH',
}

export class CreateRechargeDto {
  @IsInt()
  @Min(100)
  amount: number;

  @IsEnum(RechargeMethod)
  method: RechargeMethod;

  @IsOptional()
  @IsString()
  txid?: string;

  @IsOptional()
  @IsString()
  screenshot?: string;

  @IsOptional()
  @IsString()
  screenshotHash?: string;
}

export class ReviewRechargeDto {
  @IsEnum(['APPROVED', 'REJECTED'])
  status: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  adminNote?: string;
}
