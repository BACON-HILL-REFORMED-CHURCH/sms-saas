import { Module } from '@nestjs/common';
import { ProviderRegistryService } from './provider-registry.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { ProvidersController } from './providers.controller';
import { MockProvider } from './adapters/mock.provider';
// import { FiveSimProvider }      from './adapters/5sim.provider';
// import { SmsActivateProvider }  from './adapters/smsactivate.provider';

@Module({
  providers: [
    CircuitBreakerService,
    MockProvider,
    {
      provide: ProviderRegistryService,
      useFactory: (cb: CircuitBreakerService, mock: MockProvider) =>
        new ProviderRegistryService([mock], cb),
      inject: [CircuitBreakerService, MockProvider],
    },
  ],
  controllers: [ProvidersController],
  exports: [ProviderRegistryService],
})
export class ProvidersModule {}
