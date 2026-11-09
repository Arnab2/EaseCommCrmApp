import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { CourierAdapter } from '../contracts/courier-adapter.interface';
import {
  CancelShipmentResult,
  CourierShipmentReference,
  CreateShipmentRequest,
  CreateShipmentResult,
  TrackShipmentResult,
} from '../contracts/courier-contracts';
import { ShipmentStatus } from '../contracts/shipment-status';

@Injectable()
export class MockCourierAdapter implements CourierAdapter {
  readonly partner = 'mock';

  async createShipment(
    request: CreateShipmentRequest,
  ): Promise<CreateShipmentResult> {
    const reference = this.referenceFor(request.orderId);
    const rawResponse = {
      result: 'success',
      shipment_id: `mock-${reference}`,
      awb: `MOCK-${reference.toUpperCase()}`,
    };

    return {
      courierShipmentId: rawResponse.shipment_id,
      awbNumber: rawResponse.awb,
      status: ShipmentStatus.CREATED,
      rawRequest: request,
      rawResponse,
    };
  }

  async trackShipment(
    reference: CourierShipmentReference,
  ): Promise<TrackShipmentResult> {
    const fetchedAt = new Date();
    const rawRequest = {
      awb: reference.awbNumber ?? null,
      shipment_id: reference.courierShipmentId ?? null,
    };
    const rawResponse = {
      status: 'IN_TRANSIT',
      scans: [
        {
          status: 'PICKED_UP',
          statusDateTime: '2026-01-01T09:00:00.000Z',
          currentLocation: 'Mock Origin Hub',
        },
        {
          status: 'IN_TRANSIT',
          statusDateTime: '2026-01-01T12:00:00.000Z',
          currentLocation: 'Mock Sorting Hub',
        },
      ],
    };

    return {
      currentStatus: ShipmentStatus.IN_TRANSIT,
      currentStatusCode: 'IN_TRANSIT',
      currentStatusDescription: 'In transit',
      currentLocation: 'Mock Sorting Hub',
      expectedDeliveryAt: null,
      events: [
        {
          status: ShipmentStatus.PICKED_UP,
          providerStatusCode: 'PICKED_UP',
          providerStatusDescription: 'Picked up',
          occurredAt: new Date('2026-01-01T09:00:00.000Z'),
          location: 'Mock Origin Hub',
          rawPayload: rawResponse.scans[0],
        },
        {
          status: ShipmentStatus.IN_TRANSIT,
          providerStatusCode: 'IN_TRANSIT',
          providerStatusDescription: 'In transit',
          occurredAt: new Date('2026-01-01T12:00:00.000Z'),
          location: 'Mock Sorting Hub',
          rawPayload: rawResponse.scans[1],
        },
      ],
      fetchedAt,
      rawRequest,
      rawResponse,
    };
  }

  async cancelShipment(
    reference: CourierShipmentReference,
  ): Promise<CancelShipmentResult> {
    return {
      cancellationConfirmed: true,
      status: ShipmentStatus.CANCELLED,
      rawRequest: {
        awb: reference.awbNumber ?? null,
        shipment_id: reference.courierShipmentId ?? null,
      },
      rawResponse: { result: 'success', status: 'CANCELLED' },
    };
  }

  private referenceFor(orderId: string): string {
    return createHash('sha256').update(orderId).digest('hex').slice(0, 12);
  }
}
