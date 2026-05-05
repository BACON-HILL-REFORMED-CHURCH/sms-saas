// ============================================================
// DTOs — validated input shapes for auth endpoints
// ============================================================

import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';

export class RegisterDto {
  @IsEmail({}, { message: 'Invalid email address' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(64)
  password: string;
}

export class LoginDto {
  @IsEmail({}, { message: 'Invalid email address' })
  email: string;

  @IsString()
  @MinLength(1)
  password: string;
}

export class VerifyEmailDto {
  @IsString()
  @MinLength(1)
  token: string;
}
