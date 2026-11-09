import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthenticatedClient } from './authenticated-client';
import { ApiClientEntity } from './entities/api-client.entity';

@Injectable()
export class ApiClientsService {
  private readonly keyPepper: string;

  constructor(
    @InjectRepository(ApiClientEntity)
    private readonly clients: Repository<ApiClientEntity>,
    config: ConfigService,
  ) {
    this.keyPepper = config.getOrThrow<string>('auth.apiKeyPepper');
  }

  async authenticate(apiKey: string): Promise<AuthenticatedClient | null> {
    const keyHash = createHmac('sha256', this.keyPepper)
      .update(apiKey, 'utf8')
      .digest('hex');
    const client = await this.clients.findOne({
      where: { keyHash, isActive: true },
      select: {
        id: true,
        tenantId: true,
        name: true,
        scopes: true,
      },
    });

    if (!client) return null;
console.log('Authenticated client:', client);
    return {
      id: client.id,
      tenantId: client.tenantId,
      name: client.name,
      scopes: client.scopes,
    };
  }
}
