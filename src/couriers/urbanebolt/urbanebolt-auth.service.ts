import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CourierApiError } from '../http/courier-api.error';
import { CourierHttpClient } from '../http/courier-http.client';

interface UrbaneBoltTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  expires?: unknown;
  status?: unknown;
}

interface CachedToken {
  value: string;
  expiresAt: number | null;
}

@Injectable()
export class UrbaneBoltAuthService {
  private cachedToken?: CachedToken;
  private refreshPromise?: Promise<CachedToken>;
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly refreshBufferMs: number;

  constructor(
    private readonly http: CourierHttpClient,
    config: ConfigService,
  ) {
    this.baseUrl = config.get<string>('couriers.urbanebolt.baseUrl', '');
    this.username = config.get<string>('couriers.urbanebolt.username', '');
    this.password = config.get<string>('couriers.urbanebolt.password', '');
    this.refreshBufferMs =
      config.get<number>(
        'couriers.urbanebolt.tokenRefreshBufferSeconds',
        60,
      ) * 1000;
  }

  async getAccessToken(): Promise<string> {
    if (this.isUsable(this.cachedToken)) return this.cachedToken.value;

    const token = await this.refreshToken();
    return token.value;
  }

  async refreshAfterUnauthorized(rejectedToken: string): Promise<string> {
    if (
      this.cachedToken &&
      this.cachedToken.value !== rejectedToken &&
      this.isUsable(this.cachedToken)
    ) {
      return this.cachedToken.value;
    }

    this.cachedToken = undefined;
    return this.getAccessToken();
  }

  private async refreshToken(): Promise<CachedToken> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.fetchToken();
    }

    const pending = this.refreshPromise;
    try {
      const token = await pending;
      this.cachedToken = token;
      return token;
    } finally {
      if (this.refreshPromise === pending) this.refreshPromise = undefined;
    }
  }

  private async fetchToken(): Promise<CachedToken> {
    const body = await this.http.request<UrbaneBoltTokenResponse>(
      {
        method: 'POST',
        baseURL: this.baseUrl,
        url: '/api/v1/auth/getToken/',
        data: { username: this.username, password: this.password },
      },
      { provider: 'urbanebolt', retryable: true },
    );

    if (
      typeof body.status === 'string' &&
      body.status.toLowerCase() !== 'success'
    ) {
      throw new CourierApiError(
        'urbanebolt',
        'COURIER_AUTHENTICATION_FAILED',
        'UrbaneBolt did not issue an access token.',
        { statusCode: 200, responseBody: body },
      );
    }

    const accessToken =
      typeof body.access_token === 'string' ? body.access_token : undefined;
    if (!accessToken || accessToken.length === 0) {
      throw new CourierApiError(
        'urbanebolt',
        'COURIER_INVALID_RESPONSE',
        'UrbaneBolt returned an invalid authentication response.',
        { statusCode: 200, responseBody: body },
      );
    }

    const expiresIn = Number(body.expires_in);
    const explicitExpiry =
      typeof body.expires === 'string' ? Date.parse(body.expires) : Number.NaN;
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
      ? Date.now() + expiresIn * 1000
      : Number.isFinite(explicitExpiry)
        ? explicitExpiry
        : null;

    return { value: accessToken, expiresAt };
  }

  private isUsable(token?: CachedToken): token is CachedToken {
    if (!token) return false;
    return token.expiresAt === null || Date.now() + this.refreshBufferMs < token.expiresAt;
  }
}
