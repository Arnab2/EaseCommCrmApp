import {
  CancelShipmentResult,
  CourierShipmentReference,
  CreateShipmentRequest,
  CreateShipmentResult,
  TrackShipmentResult,
} from './courier-contracts';

export interface CourierAdapter {
  readonly partner: string;

  createShipment(
    request: CreateShipmentRequest,
  ): Promise<CreateShipmentResult>;

  trackShipment(
    reference: CourierShipmentReference,
  ): Promise<TrackShipmentResult>;

  cancelShipment(
    reference: CourierShipmentReference,
  ): Promise<CancelShipmentResult>;
}
