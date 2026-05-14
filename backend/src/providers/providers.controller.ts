// ============================================================
// ProvidersController — public endpoints for service catalog
// ============================================================

import { Controller, Get, Query, DefaultValuePipe, UseGuards } from '@nestjs/common';
import { ProviderRegistryService } from './provider-registry.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

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

  /**
   * GET /api/v1/providers/circuit-state
   * Admin: current circuit breaker state for every provider
   */
  @Get('circuit-state')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  getCircuitState() {
    return this.registry.getCircuitStates();
  }
}
