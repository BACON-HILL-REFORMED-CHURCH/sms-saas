// ============================================================
// NestJS Bootstrap — SMS SaaS Backend
// ============================================================

import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn'],
  });

  // Global API prefix
  app.setGlobalPrefix('api/v1');

  // ── Security & validation ──────────────────────────────────

  // Validate + strip all DTOs globally
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,              // Strip unknown fields
      forbidNonWhitelisted: true,   // 400 if extra fields sent
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Normalize all error responses
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Log every request + wrap success responses
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new ResponseInterceptor(),
  );

  // CORS — allow Railway domains + localhost + custom FRONTEND_URL
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) return callback(null, true);
      if (origin.startsWith('http://localhost')) return callback(null, true);
      if (origin.endsWith('.railway.app')) return callback(null, true);
      const allowed = (process.env.FRONTEND_URL ?? '').split(',').filter(Boolean);
      if (allowed.includes(origin)) return callback(null, true);
      callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // Security headers (basic hardening without helmet 