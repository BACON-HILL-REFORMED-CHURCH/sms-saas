import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ISmsProvider } from './interfaces/sms-provider.interface';
import { ProviderRegistryService } from './provider-registry.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { ProvidersController } from './providers.controller';
import { MockProvider } from './adapters/mock.provider';
import { SmsPoolProvider } from './adapters/smspool.provider';
// import { FiveSimProvider }      from './adapters/5sim.provider';
// import { SmsActivateProvider }  from './adapters/smsactivate.provider';

@Module({
  providers: [
    CircuitBreakerService,
    MockProvider,
    SmsPoolProvider,
    {
      provide: ProviderRegistryService,
      useFactory: (
        cb: CircuitBreakerService,
        config: ConfigService,
        mock: MockProvider,
        smspool: SmsPoolProvider,
      ) => {
        const providers: ISmsProvider[] = [mock];
        // Only register SMSPool if an API key is configured
        if (config.get('PROVIDER_SMSPOOL_API_KEY')) {
          providers.push(smspool);
        }
        return new ProviderRegistryService(providers, cb);
      },
      inject: [CircuitBreakerService, ConfigService, MockProvider, SmsPoolProvider],
    },
  ],
  controllers: [ProvidersController],
  exports: [ProviderRegistryService],
})
export class ProvidersModule {}
