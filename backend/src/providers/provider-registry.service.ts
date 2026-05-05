// ============================================================
// ProviderRegistryService — central lookup for all SMS providers
//
// Usage in other services:
//   const provider = this.registry.get('mock');
//   const provider = this.registry.getBest('telegram', 'us');
// ============================================================

import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { ISmsProvider } from './interfaces/sms-provider.interface';

@Injectable()
export class ProviderRegistryService {
  private readonly logger = new Logger(ProviderRegistryService.name);
  private readonly providers = new Map<string, ISmsProvider>();

  constructor(providers: ISmsProvider[]) {
    for (const p of providers) {
      this.providers.set(p.name, p);
      this.logger.log(`✅ Registered provider: ${p.name}`);
    }
  }

  // ── Get a specific provider by name ───────────────────────

  get(name: string): ISmsProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new NotFoundException(
        `Provider "${name}" not found. Available: ${this.listNames().join(', ')}`,
      );
    }
    return provider;
  }

  // ── Get the cheapest available provider for a service ─────

  async getBest(service: string, country: string): Promise<ISmsProvider> {
    let bestProvider: ISmsProvider | null = null;
    let bestPrice = Infinity;

    for (const provider of this.providers.values()) {
      try {
        const services = await provider.listServices(country);
        const svc = services.find((s) => s.name === service);

        if (svc && svc.count > 0 && svc.price < bestPrice) {
          bestPrice = svc.price;
          bestProvider = provider;
        }
      } catch (err) {
        this.logger.warn(`Provider ${provider.name} failed listServices: ${err}`);
      }
    }

    if (!bestProvider) {
      throw new NotFoundException(
        `No provider available for service="${service}" country="${country}"`,
      );
    }

    this.logger.debug(`Best provider for ${service}/${country}: ${bestProvider.name} @ ${bestPrice}¢`);
    return bestProvider;
  }

  // ── List all registered provider names ────────────────────

  listNames(): string[] {
    return Array.from(this.providers.keys());
  }

  // ── Aggregate services across all providers ───────────────

  async listAllServices(country: string) {
    const results: Record<string, any[]> = {};

    for (const [name, provider] of this.providers.entries()) {
      try {
        results[name] = await provider.listServices(country);
      } catch {
        results[name] = [];
      }
    }

    return results;
  }
}
