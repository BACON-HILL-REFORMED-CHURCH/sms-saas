import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { ISmsProvider, IProviderNumber } from './interfaces/sms-provider.interface';
import { CircuitBreakerService } from './circuit-breaker.service';

@Injectable()
export class ProviderRegistryService {
  private readonly logger = new Logger(ProviderRegistryService.name);
  private readonly providers = new Map<string, ISmsProvider>();

  constructor(
    providers: ISmsProvider[],
    private readonly cb: CircuitBreakerService,
  ) {
    for (const p of providers) {
      this.providers.set(p.name, p);
      this.logger.log(`✅ Registered provider: ${p.name}`);
    }
  }

  // ── Lookup ────────────────────────────────────────────────

  get(name: string): ISmsProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new NotFoundException(
        `Provider "${name}" not found. Available: ${this.listNames().join(', ')}`,
      );
    }
    return provider;
  }

  // ── Number acquisition with circuit breaker ───────────────

  /**
   * Get a number from a specific provider, wrapped in the circuit breaker.
   * Throws ServiceUnavailableException if the circuit is OPEN or the call fails.
   */
  async getNumberFrom(
    providerName: string,
    service: string,
    country: string,
  ): Promise<{ provider: ISmsProvider; number: IProviderNumber }> {
    const provider = this.get(providerName);
    try {
      const number = await this.cb.execute(providerName, () =>
        provider.getNumber(service, country),
      );
      return { provider, number };
    } catch (err) {
      throw new ServiceUnavailableException(
        `Provider "${providerName}" unavailable: ${err.message}`,
      );
    }
  }

  /**
   * Auto-select the cheapest healthy provider and get a number from it.
   * Tries providers in ascending price order, falling back on failure.
   * Records circuit breaker events on each attempt.
   */
  async getBestNumber(
    service: string,
    country: string,
  ): Promise<{ provider: ISmsProvider; number: IProviderNumber }> {
    const ranked = await this.getRankedProviders(service, country);

    if (ranked.length === 0) {
      throw new ServiceUnavailableException(
        `No healthy providers available for ${service}/${country}`,
      );
    }

    for (const provider of ranked) {
      try {
        const number = await this.cb.execute(provider.name, () =>
          provider.getNumber(service, country),
        );
        this.logger.log(`Selected provider ${provider.name} for ${service}/${country}`);
        return { provider, number };
      } catch (err) {
        this.logger.warn(
          `Provider ${provider.name} failed for ${service}/${country}: ${err.message} — trying next`,
        );
      }
    }

    throw new ServiceUnavailableException(
      `All providers failed for ${service}/${country}`,
    );
  }

  // ── Legacy: cheapest provider (used by getBest callers) ───

  async getBest(service: string, country: string): Promise<ISmsProvider> {
    const ranked = await this.getRankedProviders(service, country);
    if (!ranked.length) {
      throw new NotFoundException(
        `No provider available for service="${service}" country="${country}"`,
      );
    }
    return ranked[0];
  }

  // ── Catalog & monitoring ──────────────────────────────────

  listNames(): string[] {
    return Array.from(this.providers.keys());
  }

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

  /** Circuit breaker state for all providers — used by admin endpoint. */
  async getCircuitStates(): Promise<Record<string, string>> {
    const states: Record<string, string> = {};
    for (const name of this.providers.keys()) {
      states[name] = await this.cb.getState(name);
    }
    return states;
  }

  // ── Private ───────────────────────────────────────────────

  /**
   * Returns providers sorted by ascending price for the given service,
   * excluding any whose circuit is currently OPEN.
   */
  private async getRankedProviders(
    service: string,
    country: string,
  ): Promise<ISmsProvider[]> {
    const entries: { provider: ISmsProvider; price: number }[] = [];

    for (const provider of this.providers.values()) {
      if (!(await this.cb.isHealthy(provider.name))) {
        this.logger.debug(`Skipping ${provider.name} — circuit OPEN`);
        continue;
      }
      try {
        const services = await provider.listServices(country);
        const svc = services.find((s) => s.name === service);
        if (svc && svc.count > 0) {
          entries.push({ provider, price: svc.price });
        }
      } catch (err) {
        this.logger.warn(`${provider.name} listServices failed: ${err.message}`);
      }
    }

    return entries.sort((a, b) => a.price - b.price).map((e) => e.provider);
  }
}
