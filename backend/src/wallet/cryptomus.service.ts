// ============================================================
// CryptomUsService — Cryptomus payment gateway integration
// ============================================================

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';

export interface CryptomUsPayment {
  uuid: string;
  url: string;
  address: string;
  amount: string;
  currency: string;
  network: string;
}

export interface CryptomUsStatus {
  uuid: string;
  status: 'wait' | 'confirm_check' | 'paid' | 'paid_over' | 'fail' | 'wrong_amount' | 'cancel' | 'system_fail';
  amount: string;
  currency: string;
}

@Injectable()
export class CryptomUsService {
  private readonly logger = new Logger(CryptomUsService.name);
  private readonly baseUrl = 'https://api.cryptomus.com/v1';

  private get merchantId(): string {
    return process.env.CRYPTOMUS_MERCHANT_ID ?? '';
  }
  private get apiKey(): string {
    return process.env.CRYPTOMUS_API_KEY ?? '';
  }

  private get isMock(): boolean {
    return !this.merchantId || !this.apiKey;
  }

  /** Build Cryptomus HMAC signature */
  private sign(body: Record<string, unknown>): string {
    const json = JSON.stringify(body);
    const base64 = Buffer.from(json).toString('base64');
    return createHash('md5').update(base64 + this.apiKey).digest('hex');
  }

  private async cryptomUsRequest(endpoint: string, body: Record<string, unknown>) {
    const sign = this.sign(body);
    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'merchant': this.merchantId,
        'sign': sign,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json() as any;
    if (!res.ok || data.state !== 0) {
      throw new BadRequestException(data?.message ?? `Cryptomus error: ${res.status}`);
    }
    return data.result;
  }

  /**
   * Create a crypto payment.
   * Returns payment details (address, url, uuid, etc.)
   */
  async createPayment(amountUsd: number, orderId: string): Promise<CryptomUsPayment> {
    if (this.isMock) {
      this.logger.warn('CRYPTOMUS_MERCHANT_ID or CRYPTOMUS_API_KEY not set — using mock payment');
      // Encode amount in uuid so getPaymentStatus can recover it
      return {
        uuid: `mock-${amountUsd.toFixed(2)}-${orderId}`,
        url: '',
        address: 'TXXXXXXXXXXXXXXXXXXXXXXXXXXXXXmock',
        amount: amountUsd.toFixed(2),
        currency: 'USDT',
        network: 'TRC20 (MOCK — no real payment needed)',
      };
    }

    const result = await this.cryptomUsRequest('/payment', {
      amount: amountUsd.toFixed(2),
      currency: 'USD',
      to_currency: 'USDT',
      order_id: orderId,
      url_callback: process.env.CRYPTOMUS_CALLBACK_URL ?? '',
      is_payment_multiple: false,
    });

    return {
      uuid: result.uuid,
      url: result.url,
      address: result.address,
      amount: result.payer_amount ?? result.amount,
      currency: result.payer_currency ?? 'USDT',
      network: result.network ?? '',
    };
  }

  /**
   * Check payment status by uuid.
   */
  async getPaymentStatus(uuid: string): Promise<CryptomUsStatus> {
    if (this.isMock || uuid.startsWith('mock-')) {
      // Extract amount from uuid format: mock-{amount}-{orderId}
      const parts = uuid.split('-');
      const amount = parts[1] ?? '0';
      return { uuid, status: 'paid', amount, currency: 'USDT' };
    }

    const result = await this.cryptomUsRequest('/payment/info', { uuid });
    return {
      uuid: result.uuid,
      status: result.status,
      amount: result.amount,
      currency: result.currency,
    };
  }
}
