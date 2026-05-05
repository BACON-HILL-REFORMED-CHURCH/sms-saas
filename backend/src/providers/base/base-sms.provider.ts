// ============================================================
// BaseSmsProvider — shared utilities for all provider adapters
// All providers should extend this class, not implement the
// interface directly.
// ============================================================

import { Logger } from '@nestjs/common';
import {
  ISmsProvider,
  IProviderNumber,
  IProviderSMS,
  IProviderService,
} from '../interfaces/sms-provider.interface';

export abstract class BaseSmsProvider implements ISmsProvider {
  abstract readonly name: string;
  protected readonly logger: Logger;

  constructor() {
    // Logger name is set after construction when name is known
    this.logger = new Logger(this.constructor.name);
  }

  abstract getNumber(service: string, country: string): Promise<IProviderNumber>;
  abstract getSMS(externalId: string): Promise<IProviderSMS>;
  abstract cancel(externalId: string): Promise<void>;
  abstract listServices(country: string): Promise<IProviderService[]>;

  // ── Shared helpers available to all providers ─────────────

  /** Extract numeric OTP from SMS text using common patterns */
  protected extractCode(text: string): string | null {
    // Try patterns in order of specificity:
    // 1. "Your code is: 123456"
    // 2. Standalone 4-8 digit number
    const patterns = [
      /(?:code|код|كود)[^\d]*(\d{4,8})/i,
      /(\d{6})\b/,
      /(\d{4,8})\b/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) return match[1];
    }
    return null;
  }

  /** Format phone number to E.164 if not already */
  protected normalizePhone(raw: string): string {
    const digits = raw.replace(/\D/g, '');
    return digits.startsWith('+') ? raw : `+${digits}`;
  }
}
