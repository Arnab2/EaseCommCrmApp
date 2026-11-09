import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKeyGuard } from './api-key.guard';
import { ApiClientsService } from './api-clients.service';
import { ApiClientEntity } from './entities/api-client.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ApiClientEntity])],
  providers: [
    ApiClientsService,
    ApiKeyGuard,
    { provide: APP_GUARD, useExisting: ApiKeyGuard },
  ],
  exports: [ApiClientsService],
})
export class AuthModule {}
