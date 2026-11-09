import { PaymentMode, ShipmentStatus } from './shipment-status';

export interface CourierAddress {
  name: string;
  phone: string;
  email?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  country: string;
  postalCode: string;
  addressType?: string;
}

export interface CreateShipmentRequest {
  orderId: string;
  serviceType: string;
  paymentMode: PaymentMode;
  declaredValue: number;
  collectableValue: number;
  item: {
    description: string;
    quantity: number;
  };
  parcel: {
    pieces: number;
    weightKg: number;
    lengthCm: number;
    breadthCm: number;
    heightCm: number;
  };
  invoice: {
    number: string;
    date: string;
    value: number;
  };
  shipper: CourierAddress;
  consignee: CourierAddress;
  returnAddress: CourierAddress;
}

export interface CourierShipmentReference {
  orderId: string;
  courierShipmentId?: string | null;
  awbNumber?: string | null;
}

export interface CreateShipmentResult {
  courierShipmentId: string | null;
  awbNumber: string | null;
  status: ShipmentStatus;
  rawRequest: unknown;
  rawResponse: unknown;
}

export interface CourierTrackingEvent {
  status: ShipmentStatus;
  providerStatusCode?: string | null;
  providerStatusDescription?: string | null;
  occurredAt: Date | null;
  location?: string | null;
  rawPayload: unknown;
}

export interface TrackShipmentResult {
  currentStatus: ShipmentStatus;
  currentStatusCode?: string | null;
  currentStatusDescription?: string | null;
  currentLocation?: string | null;
  expectedDeliveryAt?: Date | null;
  events: CourierTrackingEvent[];
  fetchedAt: Date;
  rawRequest: unknown;
  rawResponse: unknown;
}

export interface CancelShipmentResult {
  cancellationConfirmed: boolean;
  status: ShipmentStatus;
  rawRequest: unknown;
  rawResponse: unknown;
}
