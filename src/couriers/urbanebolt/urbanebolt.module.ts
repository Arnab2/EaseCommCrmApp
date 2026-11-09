import { Module } from '@nestjs/common';
import { CourierHttpModule } from '../http/courier-http.module';
import { UrbaneBoltAdapter } from './urbanebolt.adapter';
import { UrbaneBoltAuthService } from './urbanebolt-auth.service';
import { UrbaneBoltMapper } from './urbanebolt.mapper';

@Module({
  imports: [CourierHttpModule],
  providers: [UrbaneBoltAdapter, UrbaneBoltAuthService, UrbaneBoltMapper],
  exports: [UrbaneBoltAdapter],
})
export class UrbaneBoltModule {}
