// ============================================================
// FiveSimProvider — adapter for api.5sim.net
//
// STATUS: Skeleton — uncomment & fill API key in .env to activate
//
// Docs: https://docs.5sim.net/
// ============================================================

// import { Injectable } from '@nestjs/common';
// import { ConfigService } from '@nestjs/config';
// import axios, { AxiosInstance } from 'axios';
// import { BaseSmsProvider } from '../base/base-sms.provider';
// import { IProviderNumber, IProviderSMS, IProviderService } from '../interfaces/sms-provider.interface';

// @Injectable()
// export class FiveSimProvider extends BaseSmsProvider {
//   readonly name = '5sim';
//   private http: AxiosInstance;

//   constructor(private readonly config: ConfigService) {
//     super();
//     this.http = axios.create({
//       baseURL: 'https://5sim.net/v1',
//       headers: {
//         Authorization: `Bearer ${config.get('PROVIDER_5SIM_API_KEY')}`,
//         Accept: 'application/json',
//       },
//     });
//   }

//   async getNumber(service: string, country: string): Promise<IProviderNumber> {
//     const res = await this.http.get(`/user/buy/activation/${country}/any/${service}`);
//     return {
//       externalId: String(res.data.id),
//       phoneNumber: `+${res.data.phone}`,
//       cost: Math.round(res.data.price * 100), // cents
//     };
//   }

//   async getSMS(externalId: string): Promise<IProviderSMS> {
//     const res = await this.http.get(`/user/check/${externalId}`);
//     const sms = res.data.sms?.[0];
//     if (!sms) return { code: null, fullText: null };
//     return {
//       code: this.extractCode(sms.text),
//       fullText: sms.text,
//     };
//   }

//   async cancel(externalId: string): Promise<void> {
//     await this.http.get(`/user/cancel/${externalId}`);
//   }

//   async listServices(country: string): Promise<IProviderService[]> {
//     const res = await this.http.get(`/guest/products/${country}/any`);
//     return Object.entries(res.data).map(([name, data]: any) => ({
//       name,
//       displayName: name.charAt(0).toUpperCase() + name.slice(1),
//       price: Math.round(data.Price * 100),
//       count: data.Qty,
//     }));
//   }
// }
export {}; // placeholder until uncommented
