import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CourierHttpClient } from './courier-http.client';

@Module({
  imports: [
    HttpModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        timeout: config.get<number>('courierHttp.timeoutMs', 10000),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        maxRedirects: 3,
      }),
    }),
  ],
  providers: [CourierHttpClient],
  exports: [CourierHttpClient],
})
export class CourierHttpModule {}
