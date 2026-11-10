import { Injectable } from '@nestjs/common';
import {
  CancelShipmentResult,
  CreateShipmentRequest,
  CreateShipmentResult,
  CourierTrackingEvent,
  TrackShipmentResult,
} from '../contracts/courier-contracts';
import { ShipmentStatus } from '../contracts/shipment-status';
import { CourierApiError } from '../http/courier-api.error';

type JsonRecord = Record<string, unknown>;

@Injectable()
export class UrbaneBoltMapper {
  toManifestPayload(
    request: CreateShipmentRequest,
    customerCode: string,
  ): JsonRecord[] {
    const addressFields = (
      prefix: 'cons' | 'shpr' | 'rtn',
      address: CreateShipmentRequest['shipper'],
    ): JsonRecord => ({
      [`${prefix}Name`]: address.name,
      [`${prefix}Address`]: [address.addressLine1, address.addressLine2]
        .filter(Boolean)
        .join(', '),
      [`${prefix}AddressType`]: address.addressType ?? '',
      [`${prefix}City`]: address.city,
      [`${prefix}State`]: address.state,
      [`${prefix}Country`]: address.country,
      [`${prefix}Pincode`]: address.postalCode,
      [`${prefix}Mobile`]: address.phone,
      [`${prefix}Email`]: address.email ?? '',
    });

    return [
      {
        customerCode,
        orderNumber: request.orderId,
        declaredValue: request.declaredValue,
        itemDescription: request.item.description,
        collectableValue: request.collectableValue,
        height: request.parcel.heightCm,
        length: request.parcel.lengthCm,
        pieces: request.parcel.pieces,
        weight: request.parcel.weightKg,
        breadth: request.parcel.breadthCm,
        serviceType: request.serviceType,
        payMode: request.paymentMode === 'COD' ? 'COD' : 'PPD',
        invoiceNumber: request.invoice.number,
        invoiceDate: request.invoice.date,
        invoiceValue: request.invoice.value,
        itemQuantity: request.item.quantity,
        ...addressFields('cons', request.consignee),
        ...addressFields('shpr', request.shipper),
        ...addressFields('rtn', request.returnAddress),
      },
    ];
  }

  fromManifestResponse(
    response: unknown,
    request: CreateShipmentRequest,
    rawRequest: unknown,
  ): CreateShipmentResult {
    const root = this.asRecord(response);
    if (!root) throw this.invalidResponse(response);

    const errors = this.asRecords(root.errorResponse);
    const matchingError = this.findOrderResult(errors, request.orderId);
    if (matchingError) {
      const providerMessage = this.stringValue(matchingError.message);
      const code = /already shipped/i.test(providerMessage ?? '')
        ? 'COURIER_ORDER_ALREADY_EXISTS'
        : 'COURIER_REJECTED_REQUEST';
      throw new CourierApiError(
        'urbanebolt',
        code,
        'UrbaneBolt did not accept the shipment.',
        { statusCode: 200, responseBody: response },
      );
    }

    const successItems = this.asRecords(root.successResponse);
    const successfulItem = this.findOrderResult(successItems, request.orderId);
    const candidates = [successfulItem, this.asRecord(root.data), root].filter(
      (item): item is JsonRecord => item !== undefined,
    );
    const awbNumber = this.firstString(candidates, [
      'awbNumber',
      'awb',
      'awbNo',
      'waybill',
      'trackingNumber',
    ]);

    if (!awbNumber) {
      throw this.invalidResponse(response);
    }

    const courierShipmentId = this.firstString(candidates, [
      'shipmentId',
      'courierShipmentId',
      'courierOrderId',
      'id',
    ]);

    return {
      courierShipmentId,
      awbNumber,
      status: ShipmentStatus.CREATED,
      rawRequest,
      rawResponse: this.redactForAudit(response),
    };
  }

  fromTrackingResponse(
    response: unknown,
    rawRequest: unknown,
    timezoneOffsetMinutes: number,
  ): TrackShipmentResult {
    const root = this.asRecord(response);
    const data = root && this.asRecord(root.data);
    const tracking = data ?? root;
    if (!tracking) throw this.invalidResponse(response);

    if (
      typeof root?.status === 'string' &&
      root.status.toLowerCase() !== 'success'
    ) {
      throw new CourierApiError(
        'urbanebolt',
        'COURIER_REJECTED_REQUEST',
        'UrbaneBolt could not retrieve tracking for this shipment.',
        { statusCode: 200, responseBody: response },
      );
    }

    const scans = this.asRecords(tracking.scans);
    const events: CourierTrackingEvent[] = scans.map((scan) => {
      const code = this.stringValue(scan.statusCode);
      return {
        status: this.mapStatus(code, scan.statusCodeDescription),
        providerStatusCode: code ?? null,
        providerStatusDescription:
          this.stringValue(scan.statusCodeDescription) ?? null,
        occurredAt: this.parseProviderDate(
          scan.statusDateTime,
          timezoneOffsetMinutes,
        ),
        location: this.stringValue(scan.currentLocation) ?? null,
        rawPayload: scan,
      };
    });

    const currentStatusCode = this.stringValue(tracking.currentStatusCode);
    const currentStatusDescription = this.stringValue(
      tracking.currentStatusCodeDescription,
    );
    const currentStatus = this.mapStatus(
      currentStatusCode ?? events[0]?.providerStatusCode,
      currentStatusDescription,
    );

    return {
      currentStatus,
      currentStatusCode: currentStatusCode ?? events[0]?.providerStatusCode ?? null,
      currentStatusDescription:
        currentStatusDescription ?? events[0]?.providerStatusDescription ?? null,
      currentLocation: this.stringValue(tracking.currentLocation) ?? null,
      expectedDeliveryAt: this.parseProviderDate(
        tracking.edd,
        timezoneOffsetMinutes,
      ),
      events,
      fetchedAt: new Date(),
      rawRequest,
      rawResponse: this.redactForAudit(response),
    };
  }

  fromCancellationResponse(
    response: unknown,
    awbNumber: string,
    rawRequest: unknown,
  ): CancelShipmentResult {
    const root = this.asRecord(response);
    if (!root) throw this.invalidResponse(response);

    if (
      typeof root.status === 'string' &&
      root.status.toLowerCase() !== 'success'
    ) {
      throw new CourierApiError(
        'urbanebolt',
        'COURIER_CANCELLATION_REJECTED',
        'UrbaneBolt did not accept the cancellation request.',
        { statusCode: 200, responseBody: response },
      );
    }

    const failures = this.asRecords(root.failureResponse);
    const matchingFailure = this.findAwbResult(failures, awbNumber);
    if (matchingFailure) {
      const failureMessage = this.stringValue(matchingFailure.message) ?? '';
      if (/already cancelled/i.test(failureMessage)) {
        return {
          cancellationConfirmed: true,
          status: ShipmentStatus.CANCELLED,
          rawRequest,
          rawResponse: this.redactForAudit(response),
        };
      }

      throw new CourierApiError(
        'urbanebolt',
        'COURIER_CANCELLATION_REJECTED',
        'UrbaneBolt did not confirm shipment cancellation.',
        { statusCode: 200, responseBody: response },
      );
    }

    const successes = this.asRecords(root.successResponse);
    const confirmed = Boolean(this.findAwbResult(successes, awbNumber));
    return {
      cancellationConfirmed: confirmed,
      status: confirmed ? ShipmentStatus.CANCELLED : ShipmentStatus.CANCEL_REQUESTED,
      rawRequest,
      rawResponse: this.redactForAudit(response),
    };
  }

  mapStatus(code?: string | null, description?: unknown): ShipmentStatus {
    const normalized = (code ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    const descriptionText = this.stringValue(description)?.toUpperCase() ?? '';
    const combined = `${normalized} ${descriptionText}`;

    if (['MAN', 'MANIFESTED', 'CREATED'].includes(normalized)) {
      return ShipmentStatus.CREATED;
    }
    if (['PUP', 'PUC', 'PICK', 'PICKED_UP'].includes(normalized) || /PICKED UP/.test(combined)) {
      return ShipmentStatus.PICKED_UP;
    }
    if (['IT', 'INT', 'IN_TRANSIT'].includes(normalized) || /IN TRANSIT/.test(combined)) {
      return ShipmentStatus.IN_TRANSIT;
    }
    if (['OFD', 'OUT_FOR_DELIVERY'].includes(normalized) || /OUT FOR DELIVERY/.test(combined)) {
      return ShipmentStatus.OUT_FOR_DELIVERY;
    }
    if (['DEL', 'DLV', 'DELIVERED'].includes(normalized) || /DELIVERED/.test(combined)) {
      return ShipmentStatus.DELIVERED;
    }
    if (['CAN', 'CANCELLED', 'CANCELED'].includes(normalized) || /CANCELLED|CANCELED/.test(combined)) {
      return ShipmentStatus.CANCELLED;
    }
    if (['RTO', 'RTS', 'RETURN_TO_ORIGIN'].includes(normalized) || /RETURN TO ORIGIN|RTO/.test(combined)) {
      return ShipmentStatus.RETURN_TO_ORIGIN;
    }
    if (['FAIL', 'FAILED', 'NDR'].includes(normalized) || /FAILED/.test(combined)) {
      return ShipmentStatus.FAILED;
    }
    return ShipmentStatus.UNKNOWN;
  }

  private findOrderResult(items: JsonRecord[], orderId: string): JsonRecord | undefined {
    return items.find((item) => this.stringValue(item.orderNumber) === orderId) ??
      (items.length === 1 ? items[0] : undefined);
  }

  private findAwbResult(items: JsonRecord[], awbNumber: string): JsonRecord | undefined {
    return items.find((item) =>
      ['awb', 'awbNumber', 'awbNo'].some(
        (key) => this.stringValue(item[key]) === awbNumber,
      ),
    ) ?? (items.length === 1 ? items[0] : undefined);
  }

  private firstString(items: JsonRecord[], keys: string[]): string | null {
    for (const item of items) {
      for (const key of keys) {
        const value = this.stringValue(item[key]);
        if (value) return value;
      }
    }
    return null;
  }

  private asRecord(value: unknown): JsonRecord | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as JsonRecord)
      : undefined;
  }

  private asRecords(value: unknown): JsonRecord[] {
    return Array.isArray(value)
      ? value.map((item) => this.asRecord(item)).filter(
          (item): item is JsonRecord => item !== undefined,
        )
      : [];
  }

  private stringValue(value: unknown): string | undefined {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
  }

  private parseProviderDate(
    value: unknown,
    timezoneOffsetMinutes: number,
  ): Date | null {
    if (typeof value !== 'string' || value.trim().length === 0) return null;
    const input = value.trim();

    if (/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:?\d{2}))?$/i.test(input)) {
      const date = new Date(input);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    const match = input.match(
      /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})(?:,\s*(\d{1,2}):(\d{2}))?$/,
    );
    if (!match) return null;

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months.findIndex((item) => item.toLowerCase() === match[2]!.toLowerCase());
    if (month < 0) return null;

    const utc = Date.UTC(
      Number(match[3]),
      month,
      Number(match[1]),
      Number(match[4] ?? 0),
      Number(match[5] ?? 0),
    ) - timezoneOffsetMinutes * 60_000;
    const date = new Date(utc);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private invalidResponse(response: unknown): CourierApiError {
    return new CourierApiError(
      'urbanebolt',
      'COURIER_INVALID_RESPONSE',
      'UrbaneBolt returned a response that could not be interpreted.',
      { statusCode: 200, responseBody: response },
    );
  }

  private redactForAudit(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.redactForAudit(item));
    }

    if (typeof value === 'string') return this.redactUrlSecrets(value);

    const record = this.asRecord(value);
    if (!record) return value;

    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [
        key,
        /password|access[_-]?token|authorization|cookie|secret|api[_-]?key/i.test(
          key,
        )
          ? '[REDACTED]'
          : this.redactForAudit(child),
      ]),
    );
  }

  private redactUrlSecrets(value: string): string {
    try {
      const url = new URL(value);
      for (const parameter of [
        'key',
        'token',
        'access_token',
        'signature',
        'sig',
        'auth',
      ]) {
        if (url.searchParams.has(parameter)) {
          url.searchParams.set(parameter, '[REDACTED]');
        }
      }
      return url.toString();
    } catch {
      return value;
    }
  }
}
