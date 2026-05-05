// ============================================================
// ProvidersModule — abstract SMS provider layer
// To add a new provider: create a class in ./adapters/
//   that extends BaseSmsProvider and register it in PROVIDERS token
// ============================================================

import { Module } from '@nestjs/common';
import { ProviderRegistryService } from './provider-registry.service';
import { ProvidersController } from './providers.controller';
import { MockProvider } from './adapters/mock.provider';
// import { FiveSimProvider }      from './adapters/5sim.provider';
// import { SmsActivateProvider }  from './adapters/smsactivate.provider';

@Module({
  providers: [
    MockProvider,
    {
      provide: ProviderRegistryService,
      useFactory: (...providers: any[]) => new ProviderRegistryService(providers),
      inject: [MockProvider],
    },
  ],
  controllers: [ProvidersController],
  exports: [ProviderRegistryService],
})
export class ProvidersModule {}
