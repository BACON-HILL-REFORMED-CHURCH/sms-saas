// ============================================================
// MockProvider — fully functional fake SMS provider
//
// Behaviour:
//   - getNumber()  → returns a fake number instantly
//   - getSMS()     → first 2 polls return null (simulating wait),
//                    then returns a realistic OTP code
//   - cancel()     → no-op
//   - listServices → returns realistic catalog with prices
//
// Use for: local development, demos, E2E tests.
// ============================================================

import { Injectable } from '@nestjs/common';
import { BaseSmsProvider } from '../base/base-sms.provider';
import {
  IProviderNumber,
  IProviderSMS,
  IProviderService,
} from '../interfaces/sms-provider.interface';

// In-memory store: externalId → { pollCount, code }
const activations = new Map<string, { pollCount: number; code: string }>();

// Fake phone numbers pool
const FAKE_NUMBERS = [
  '+19175551234', '+14085559876', '+12015553456',
  '+17325557890', '+16465551111', '+13105552222',
];

// Realistic service catalog
const SERVICE_CATALOG: IProviderService[] = [
  { name: 'telegram',   displayName: 'Telegram',   price: 25,  count: 142 },
  { name: 'whatsapp',   displayName: 'WhatsApp',   price: 30,  count: 98  },
  { name: 'google',     displayName: 'Google',     price: 20,  count: 210 },
  { name: 'facebook',   displayName: 'Facebook',   price: 20,  count: 185 },
  { name: 'instagram',  displayName: 'Instagram',  price: 25,  count: 76  },
  { name: 'twitter',    displayName: 'Twitter/X',  price: 35,  count: 54  },
  { name: 'tiktok',     displayName: 'TikTok',     price: 30,  count: 120 },
  { name: 'discord',    displayName: 'Discord',    price: 20,  count: 200 },
  { name: 'uber',       displayName: 'Uber',       price: 45,  count: 33  },
  { name: 'amazon',     displayName: 'Amazon',     price: 30,  count: 67  },
];

@Injectable()
export class MockProvider extends BaseSmsProvider {
  readonly name = 'mock';

  // ── getNumber ─────────────────────────────────────────────

  async getNumber(service: string, _country: string): Promise<IProviderNumber> {
    this.logger.debug(`getNumber() → service=${service}`);

    const externalId = `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const phoneNumber = FAKE_NUMBERS[Math.floor(Math.random() * FAKE_NUMBERS.length)];
    const code = String(Math.floor(100_000 + Math.random() * 900_000)); // 6-digit OTP

    // Store activation state
    activations.set(externalId, { pollCount: 0, code });

    // Find service price
    const svc = SERVICE_CATALOG.find((s) => s.name === service);
    const cost = svc?.price ?? 25;

    return { externalId, phoneNumber, cost };
  }

  // ── getSMS ────────────────────────────────────────────────

  async getSMS(externalId: string): Promise<IProviderSMS> {
    const activation = activations.get(externalId);

    if (!activation) {
      this.logger.warn(`getSMS() — unknown activation: ${externalId}`);
      return { code: null, fullText: null };
    }

    activation.pollCount++;
    this.logger.debug(`getSMS() poll #${activation.pollCount} for ${externalId}`);

    // Simulate real-world delay: SMS arrives after 2 polls (~10-20 seconds)
    if (activation.pollCount < 2) {
      return { code: null, fullText: null };
    }

    const fullText = `Your verification code is ${activation.code}. Do not share it with anyone.`;
    const code = this.extractCode(fullText);

    return { code, fullText };
  }

  // ── cancel ────────────────────────────────────────────────

  async cancel(externalId: string): Promise<void> {
    this.logger.debug(`cancel() → ${externalId}`);
    activations.delete(externalId);
  }

  // ── listServices ──────────────────────────────────────────

  async listServices(_country: string): Promise<IProviderService[]> {
    // Randomize "count" slightly on each call to feel live
    return SERVICE_CATALOG.map((s) => ({
      ...s,
      count: s.count + Math.floor(Math.random() * 20) - 10,
    }));
  }
}
