// ============================================================
// ProvidersController — public endpoints for service catalog
// ============================================================

import { Controller, Get, Query, DefaultValuePipe, UseGuards } from '@nestjs/common';
import { ProviderRegistryService } from './provider-registry.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('providers')
@UseGuards(JwtAuthGuard)
export class ProvidersController {
  constructor(private readonly registry: ProviderRegistryService) {}

  /**
   * GET /api/v1/providers
   * List all registered providers
   */
  @Get()
  listProviders() {
    return { providers: this.registry.listNames() };
  }

  /**
   * GET /api/v1/providers/services?country=us
   * List all services across all providers for a country
   */
  @Get('services')
  listServices(
    @Query('country', new DefaultValuePipe('us')) country: string,
  ) {
    return this.registry.listAllServices(country);
  }
}
