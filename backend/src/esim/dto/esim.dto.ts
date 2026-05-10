import {
  IsString, IsNumber, IsBoolean, IsOptional,
  IsPositive, Min, Max,
} from 'class-validator';

export class CreateEsimProductDto {
  @IsString() name: string;
  @IsString() country: string;
  @IsString() countryCode: string;
  @IsNumber() @IsPositive() gb: number;
  @IsNumber() @IsPositive() days: number;
  @IsNumber() @IsPositive() price: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateEsimProductDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() countryCode?: string;
  @IsOptional() @IsNumber() @IsPositive() gb?: number;
  @IsOptional() @IsNumber() @IsPositive() days?: number;
  @IsOptional() @IsNumber() @IsPositive() price?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class AddInventoryDto {
  @IsString() productId: string;
  @IsString() qrCodeData: string;
  @IsOptional() @IsString() activationCode?: string;
}
