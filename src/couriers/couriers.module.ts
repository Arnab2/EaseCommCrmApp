import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CourierAdapter } from './contracts/courier-adapter.interface';
import { CourierRegistry } from './courier.registry';
import { COURIER_ADAPTERS } from './courier.tokens';
import { MockCourierAdapter } from './mock-courier/mock-courier.adapter';
import { UrbaneBoltAdapter } from './urbanebolt/urbanebolt.adapter';
import { UrbaneBoltModule } from './urbanebolt/urbanebolt.module';

@Module({
  imports: [UrbaneBoltModule],
  providers: [
    MockCourierAdapter,
    {
      provide: COURIER_ADAPTERS,
      inject: [ConfigService, MockCourierAdapter, UrbaneBoltAdapter],
      useFactory: (
        config: ConfigService,
        mockCourier: CourierAdapter,
        urbanebolt: CourierAdapter,
      ): CourierAdapter[] =>
        config.get<boolean>('couriers.urbanebolt.enabled', false)
          ? [mockCourier, urbanebolt]
          : [mockCourier],
    },
    CourierRegistry,
  ],
  exports: [CourierRegistry],
})
export class CouriersModule {}
