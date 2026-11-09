import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiClientsService } from './api-clients.service';
import { AuthenticatedRequest } from './authenticated-client';
import { IS_PUBLIC_KEY, REQUIRED_SCOPES_KEY } from './public.decorator';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly clients: ApiClientsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const apiKey = request.headers['x-api-key'];
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      throw this.unauthorized();
    }

    const client = await this.clients.authenticate(apiKey);
    if (!client) throw this.unauthorized();

    const requiredScopes = this.reflector.getAllAndOverride<string[]>(
      REQUIRED_SCOPES_KEY,
      [context.getHandler(), context.getClass()],
    ) ?? [];
    if (
      !client.scopes.includes('*') &&
      !requiredScopes.every((scope) => client.scopes.includes(scope))
    ) {
      throw new ForbiddenException({
        code: 'INSUFFICIENT_SCOPE',
        message: 'The API client does not have permission for this operation.',
      });
    }

    request.authClient = client;
    return true;
  }

  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'A valid x-api-key header is required.',
    });
  }
}
