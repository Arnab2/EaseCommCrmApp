import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosRequestConfig } from 'axios';
import {
  CancelShipmentResult,
  CourierShipmentReference,
  CreateShipmentRequest,
  CreateShipmentResult,
  TrackShipmentResult,
} from '../contracts/courier-contracts';
import { CourierAdapter } from '../contracts/courier-adapter.interface';
import { CourierApiError } from '../http/courier-api.error';
import { CourierHttpClient } from '../http/courier-http.client';
import { UrbaneBoltAuthService } from './urbanebolt-auth.service';
import { UrbaneBoltMapper } from './urbanebolt.mapper';

@Injectable()
export class UrbaneBoltAdapter implements CourierAdapter {
  readonly partner = 'urbanebolt';
  private readonly logger = new Logger(UrbaneBoltAdapter.name);

  private readonly baseUrl: string;
  private readonly customerCode: string;
  private readonly timezoneOffsetMinutes: number;

  constructor(
    private readonly http: CourierHttpClient,
    private readonly auth: UrbaneBoltAuthService,
    private readonly mapper: UrbaneBoltMapper,
    config: ConfigService,
  ) {
    this.baseUrl = config.get<string>('couriers.urbanebolt.baseUrl', '');
    this.customerCode = config.get<string>(
      'couriers.urbanebolt.customerCode',
      '',
    );
    this.timezoneOffsetMinutes = config.get<number>(
      'couriers.urbanebolt.timezoneOffsetMinutes',
      330,
    );
  }

  async createShipment(
    request: CreateShipmentRequest,
  ): Promise<CreateShipmentResult> {
    const rawRequest = this.mapper.toManifestPayload(
      request,
      this.customerCode,
    );
    const rawResponse = await this.authorizedRequest<unknown>(
      {
        method: 'POST',
        baseURL: this.baseUrl,
        url: '/api/v1/services/manifest/',
        data: rawRequest,
      },
      false,
    );
    this.logger.debug(
      JSON.stringify({
        event: 'urbanebolt_create_shipment_response',
        rawResponse,
      }),
    );
    return this.mapper.fromManifestResponse(rawResponse, request, rawRequest);
  }

  async trackShipment(
    reference: CourierShipmentReference,
  ): Promise<TrackShipmentResult> {
    if (!reference.awbNumber) {
      throw new CourierApiError(
        this.partner,
        'COURIER_REFERENCE_MISSING',
        'An AWB number is required to track this shipment.',
      );
    }

    const rawRequest = { awb: reference.awbNumber };
    const rawResponse = await this.authorizedRequest<unknown>(
      {
        method: 'GET',
        baseURL: this.baseUrl,
        url: '/api/v1/services/tracking-pub/',
        params: rawRequest,
      },
      true,
    );

    return this.mapper.fromTrackingResponse(
      rawResponse,
      rawRequest,
      this.timezoneOffsetMinutes,
    );
  }

  async cancelShipment(
    reference: CourierShipmentReference,
  ): Promise<CancelShipmentResult> {
    if (!reference.awbNumber) {
      throw new CourierApiError(
        this.partner,
        'COURIER_REFERENCE_MISSING',
        'An AWB number is required to cancel this shipment.',
      );
    }

    const rawRequest = { awbs: reference.awbNumber };
    const rawResponse = await this.authorizedRequest<unknown>(
      {
        method: 'POST',
        baseURL: this.baseUrl,
        url: '/api/v1/services/cancel/',
        data: rawRequest,
      },
      false,
    );

    return this.mapper.fromCancellationResponse(
      rawResponse,
      reference.awbNumber,
      rawRequest,
    );
  }

  private async authorizedRequest<T>(
    request: AxiosRequestConfig,
    retryable: boolean,
  ): Promise<T> {
    const accessToken = await this.auth.getAccessToken();
    try {
      return await this.send<T>(request, accessToken, retryable);
    } catch (error) {
      if (!(error instanceof CourierApiError) || error.statusCode !== 401) {
        throw error;
      }

      const refreshedToken =
        await this.auth.refreshAfterUnauthorized(accessToken);
      return this.send<T>(request, refreshedToken, retryable);
    }
  }

  private send<T>(
    request: AxiosRequestConfig,
    token: string,
    retryable: boolean,
  ): Promise<T> {
    return this.http.request<T>(
      {
        ...request,
        headers: {
          ...request.headers,
          Authorization: `Bearer ${token}`,
        },
      },
      { provider: this.partner, retryable },
    );
  }
}
