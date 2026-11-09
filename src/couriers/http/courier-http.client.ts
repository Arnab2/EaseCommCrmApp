import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { firstValueFrom } from 'rxjs';
import { CourierApiError } from './courier-api.error';

export interface CourierRequestPolicy {
  provider: string;
  retryable: boolean;
}

@Injectable()
export class CourierHttpClient {
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  constructor(
    config: ConfigService,
    private readonly http: HttpService,
  ) {
    this.maxRetries = config.get<number>('courierHttp.maxRetries', 3);
    this.retryBaseDelayMs = config.get<number>(
      'courierHttp.retryBaseDelayMs',
      500,
    );
    this.retryMaxDelayMs = config.get<number>(
      'courierHttp.retryMaxDelayMs',
      5000,
    );
  }

  async request<T>(
    request: AxiosRequestConfig,
    policy: CourierRequestPolicy,
  ): Promise<T> {
    let retryCount = 0;

    for (;;) {
      try {
        const response = await firstValueFrom(this.http.request<T>(request));
        return response.data;
      } catch (error) {
        const courierError = this.toCourierError(error, policy.provider);
        if (
          !policy.retryable ||
          !courierError.retryable ||
          retryCount >= this.maxRetries
        ) {
          throw courierError;
        }

        retryCount += 1;
        await this.sleep(this.retryDelay(retryCount, courierError.retryAfterMs));
      }
    }
  }

  private toCourierError(error: unknown, provider: string): CourierApiError {
    if (!axios.isAxiosError(error)) {
      return new CourierApiError(
        provider,
        'COURIER_UNEXPECTED_ERROR',
        'The courier request failed unexpectedly.',
        { cause: error },
      );
    }

    const axiosError = error as AxiosError<unknown>;
    const statusCode = axiosError.response?.status;
    const responseBody = axiosError.response?.data;
    const retryable = this.isTransient(axiosError);
    const retryAfterMs = this.getRetryAfterMs(axiosError);
    const timeout =
      axiosError.code === 'ETIMEDOUT' || axiosError.code === 'ECONNABORTED';

    let code: string;
    let message: string;
    if (statusCode === 401 || statusCode === 403) {
      code = 'COURIER_AUTHENTICATION_FAILED';
      message = 'The courier rejected the authentication credentials.';
    } else if (statusCode === 429) {
      code = 'COURIER_RATE_LIMITED';
      message = 'The courier rate limit was reached.';
    } else if (statusCode !== undefined && statusCode >= 500) {
      code = 'COURIER_UNAVAILABLE';
      message = 'The courier service is temporarily unavailable.';
    } else if (statusCode !== undefined) {
      code = 'COURIER_REJECTED_REQUEST';
      message = 'The courier rejected the request.';
    } else if (timeout) {
      code = 'COURIER_TIMEOUT';
      message = 'The courier request timed out.';
    } else {
      code = 'COURIER_NETWORK_ERROR';
      message = 'The courier could not be reached.';
    }

    return new CourierApiError(provider, code, message, {
      statusCode,
      responseBody,
      retryAfterMs,
      retryable,
      cause: error,
    });
  }

  private isTransient(error: AxiosError): boolean {
    const statusCode = error.response?.status;
    if (statusCode === 429 || (statusCode !== undefined && statusCode >= 500)) {
      return true;
    }
    if (statusCode !== undefined) return false;

    return [
      'ETIMEDOUT',
      'ECONNABORTED',
      'ECONNRESET',
      'ECONNREFUSED',
      'EAI_AGAIN',
      'ENOTFOUND',
    ].includes(error.code ?? '');
  }

  private getRetryAfterMs(error: AxiosError): number | undefined {
    const raw = error.response?.headers['retry-after'];
    if (typeof raw !== 'string') return undefined;

    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

    const dateMs = Date.parse(raw);
    return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
  }

  private retryDelay(
    retryCount: number,
    retryAfterMs?: number,
  ): number {
    if (retryAfterMs !== undefined) {
      return Math.min(this.retryMaxDelayMs, retryAfterMs);
    }

    const exponential = Math.min(
      this.retryMaxDelayMs,
      this.retryBaseDelayMs * 2 ** (retryCount - 1),
    );
    return Math.round(exponential * (0.8 + Math.random() * 0.4));
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
