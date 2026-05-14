// ============================================================
// SmsPoolProvider — adapter for api.smspool.net
//
// Auth:    "key" field in multipart/form-data body
// Transport: all requests are POST with multipart/form-data
// Docs:    https://www.smspool.net/article/how-to-use-the-smspool-api
//
// Status codes for /sms/check:
//   1 = Pending   2 = Failed/Expired   3 = SMS Received
// ============================================================

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { FormData } from 'formdata-node';
import { BaseSmsProvider } from '../base/base-sms.provider';
import {
  IProviderNumber,
  IProviderSMS,
  IProviderService,
} from '../interfaces/sms-provider.interface';

@Injectable()
export class SmsPoolProvider extends BaseSmsProvider {
  readonly name = 'smspool';
  private readonly http: AxiosInstance;
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    super();
    this.apiKey = config.get<string>('PROVIDER_SMSPOOL_API_KEY', '');
    this.http = axios.create({
      baseURL: 'https://api.smspool.net',
      timeout: 10_000,
    });
  }

  // ── getNumber ─────────────────────────────────────────────

  async getNumber(service: string, country: string): Promise<IProviderNumber> {
    const countryCode = country.toUpperCase();

    // Fetch real price first — SMSPool doesn't include it in the purchase response
    const priceRes = await this.post('/request/price', {
      key: this.apiKey,
      country: countryCode,
      service,
    });
    const costCents = Math.round((Number(priceRes.price) || 0) * 100);

    // Purchase the number
    const buyRes = await this.post('/purchase/sms', {
      key: this.apiKey,
      country: countryCode,
      service,
      max_price: priceRes.price ?? 99,
    });

    if (!buyRes.success || !buyRes.number) {
      throw new Error(buyRes.message || 'SMSPool purchase failed');
    }

    return {
      externalId: String(buyRes.order_id),
      phoneNumber: String(buyRes.number),
      cost: costCents,
    };
  }

  // ── getSMS ────────────────────────────────────────────────

  async getSMS(externalId: string): Promise<IProviderSMS> {
    const res = await this.post('/sms/check', {
      key: this.apiKey,
      orderid: externalId,
    });

    // status === 3 means the SMS has arrived
    if (res.status === 3 && res.full_sms) {
      const fullText = String(res.full_sms);
      return {
        code: this.extractCode(fullText) ?? String(res.sms ?? res.code ?? ''),
        fullText,
      };
    }

    return { code: null, fullText: null };
  }

  // ── cancel ────────────────────────────────────────────────

  async cancel(externalId: string): Promise<void> {
    await this.post('/sms/cancel', {
      key: this.apiKey,
      orderid: externalId,
    });
  }

  // ── listServices ──────────────────────────────────────────

  async listServices(country: string): Promise<IProviderService[]> {
    // No auth required — returns [{ID, name}] for the given country
    // price=0: real price fetched per-order via /request/price in getNumber()
    // count=999: SMSPool doesn't expose stock via this endpoint
    const res = await this.post('/service/retrieve_all', {
      country: country.toUpperCase(),
    });

    if (!Array.isArray(res)) return [];

    return res.map((svc: any) => ({
      name: String(svc.name).toLowerCase(),
      displayName: svc.name,
      price: 0,
      count: 999,
    }));
  }

  // ── Shared POST helper ────────────────────────────────────

  private async post(endpoint: string, fields: Record<string, string | number>): Promise<any> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.set(key, String(value));
    }
    const res = await this.http.post(endpoint, form);
    return res.data;
  }
}
