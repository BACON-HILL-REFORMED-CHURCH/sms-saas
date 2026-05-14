// ============================================================
// SmsPoolProvider — adapter for api.smspool.net
//
// Auth:    ?key=<API_KEY> query param on every authenticated request
// Docs:    https://www.smspool.net/article/how-to-use-the-smspool-api
//
// Status codes for /sms/check:
//   1 = Pending   2 = Failed/Expired   3 = SMS Received
// ============================================================

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
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

    // Fetch real price before purchasing (SMSPool returns price separately)
    const priceRes = await this.http.get('/request/price', {
      params: { key: this.apiKey, country: countryCode, service },
    });
    const costCents = Math.round((Number(priceRes.data.price) || 0) * 100);

    // Purchase the number
    const buyRes = await this.http.get('/purchase/sms', {
      params: { key: this.apiKey, country: countryCode, service },
    });

    if (!buyRes.data.success || !buyRes.data.number) {
      throw new Error(buyRes.data.message || 'SMSPool purchase failed');
    }

    return {
      externalId: String(buyRes.data.order_id),
      phoneNumber: String(buyRes.data.number),
      cost: costCents,
    };
  }

  // ── getSMS ────────────────────────────────────────────────

  async getSMS(externalId: string): Promise<IProviderSMS> {
    const res = await this.http.get('/sms/check', {
      params: { key: this.apiKey, orderid: externalId },
    });

    // status === 3 means the SMS has been received
    if (res.data.status === 3 && res.data.full_sms) {
      const fullText = String(res.data.full_sms);
      return {
        code: this.extractCode(fullText) ?? String(res.data.sms ?? ''),
        fullText,
      };
    }

    return { code: null, fullText: null };
  }

  // ── cancel ────────────────────────────────────────────────

  async cancel(externalId: string): Promise<void> {
    await this.http.get('/sms/cancel', {
      params: { key: this.apiKey, orderid: externalId },
    });
  }

  // ── listServices ──────────────────────────────────────────

  async listServices(country: string): Promise<IProviderService[]> {
    const countryCode = country.toUpperCase();

    // SMSPool returns only names (no per-service price) at this endpoint.
    // Real price is fetched per-order in getNumber() via /request/price.
    // price=0 here means this provider ranks cheapest in getBestNumber();
    // the actual billing price always comes from getNumber().cost.
    const res = await this.http.get('/service/retrieve_all', {
      params: { country: countryCode },
    });

    if (!Array.isArray(res.data)) return [];

    return res.data.map((svc: any) => ({
      name: String(svc.name).toLowerCase(),
      displayName: svc.name,
      price: 0,    // unknown until /request/price is called in getNumber()
      count: 999,  // stock not exposed by this endpoint
    }));
  }
}
