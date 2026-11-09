import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { CourierApiError } from '../couriers/http/courier-api.error';
import { CourierRegistry } from '../couriers/courier.registry';
import {
  CancelShipmentResult,
  CreateShipmentRequest,
  CreateShipmentResult,
  TrackShipmentResult,
} from '../couriers/contracts/courier-contracts';
import { ShipmentStatus } from '../couriers/contracts/shipment-status';
import { CourierShipmentReference } from '../couriers/contracts/courier-contracts';
import { AuthenticatedClient } from '../auth/authenticated-client';
import { CreateOrderDto } from './dto/create-order.dto';
import { CancelOrderDto } from './dto/cancel-order.dto';
import {
  CourierOperationAttemptEntity,
} from './entities/courier-operation-attempt.entity';
import { OrderEntity } from './entities/order.entity';
import { JsonPayload, TrackingEventEntity } from './entities/tracking-event.entity';
import { BulkOrderBatchEntity } from '../bulk-orders/entities/bulk-order-batch.entity';
import { BulkOrderItemEntity } from '../bulk-orders/entities/bulk-order-item.entity';

interface CreateOrderContext {
  requestId: string;
  client: AuthenticatedClient;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(OrderEntity)
    private readonly orders: Repository<OrderEntity>,
    @InjectRepository(CourierOperationAttemptEntity)
    private readonly attempts: Repository<CourierOperationAttemptEntity>,
    private readonly dataSource: DataSource,
    private readonly couriers: CourierRegistry,
  ) {}

  async create(dto: CreateOrderDto, context: CreateOrderContext) {
    const partner = dto.courier_partner.trim().toLowerCase();
    // Resolve before reserving the idempotency key so unsupported partners do
    // not leave a permanently pending order in the database.
    const courier = this.couriers.get(partner);
    const shipmentRequest = this.toShipmentRequest(dto);
    const existing = await this.orders.findOneBy({
      tenantId: context.client.tenantId,
      externalOrderId: dto.order_id,
    });
    if (existing) return this.replayOrConflict(existing, dto, partner);
    const order = this.orders.create({
      tenantId: context.client.tenantId,
      externalOrderId: dto.order_id,
      courierPartner: partner,
      processingStatus: 'CREATE_PENDING',
      shipmentStatus: null,
      courierShipmentId: null,
      awbNumber: null,
      requestPayload: dto as unknown as Record<string, unknown>,
      courierRequestPayload: null,
      courierResponsePayload: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    });

    const attempt = this.attempts.create({
      operation: 'CREATE_SHIPMENT',
      outcome: 'STARTED',
      requestId: context.requestId,
      requestPayload: dto,
      responsePayload: null,
      errorCode: null,
      errorMessage: null,
      completedAt: null,
    });

    try {
      await this.dataSource.transaction(async (manager) => {
        const savedOrder = await manager.getRepository(OrderEntity).save(order);
        attempt.orderId = savedOrder.id;
        await manager.getRepository(CourierOperationAttemptEntity).save(attempt);
        Object.assign(order, savedOrder);
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const concurrent = await this.orders.findOneBy({
          tenantId: context.client.tenantId,
          externalOrderId: dto.order_id,
        });
        if (concurrent) return this.replayOrConflict(concurrent, dto, partner);
      }
      throw error;
    }

    try {
      const result = await courier.createShipment(shipmentRequest);
      const completedAt = new Date();
      await this.dataSource.transaction(async (manager) => {
        order.processingStatus = 'CREATED';
        order.shipmentStatus = result.status;
        order.courierShipmentId = result.courierShipmentId;
        order.awbNumber = result.awbNumber;
        order.courierRequestPayload = result.rawRequest;
        order.courierResponsePayload = result.rawResponse;
        order.lastErrorCode = null;
        order.lastErrorMessage = null;
        await manager.getRepository(OrderEntity).save(order);

        attempt.outcome = 'SUCCEEDED';
        attempt.requestPayload = result.rawRequest;
        attempt.responsePayload = result.rawResponse;
        attempt.completedAt = completedAt;
        await manager.getRepository(CourierOperationAttemptEntity).save(attempt);

        const event = manager.getRepository(TrackingEventEntity).create({
          orderId: order.id,
          source: 'CREATE',
          status: result.status,
          providerStatusCode: null,
          providerStatusDescription: 'Shipment created',
          location: null,
          occurredAt: completedAt,
          rawPayload: this.toJsonValue(this.redactForAudit(result.rawResponse)),
          eventFingerprint: this.eventFingerprint({
            source: 'CREATE',
            status: result.status,
            rawPayload: result.rawResponse,
          }),
        });
        await manager.getRepository(TrackingEventEntity).save(event);
      });
      return this.toResponse(order, false);
    } catch (error) {
      // If the courier accepted a request but our DB commit failed, keep the
      // reservation pending. Replaying the external POST could create a duplicate.
      if (!this.isCourierError(error)) {
        this.logFailure(order, context.requestId, 'PERSISTENCE_OR_INTERNAL_ERROR', error);
        throw error;
      }

      const code = error.code;
      const message = 'The courier could not create this shipment.';
      try {
        await this.dataSource.transaction(async (manager) => {
          order.processingStatus = 'CREATE_FAILED';
          order.shipmentStatus = ShipmentStatus.FAILED;
          order.lastErrorCode = code;
          order.lastErrorMessage = message;
          await manager.getRepository(OrderEntity).save(order);

          attempt.outcome = 'FAILED';
          attempt.errorCode = code;
          attempt.errorMessage = message;
          attempt.responsePayload = this.redactForAudit(error.responseBody ?? null);
          attempt.completedAt = new Date();
          await manager.getRepository(CourierOperationAttemptEntity).save(attempt);

          const event = manager.getRepository(TrackingEventEntity).create({
            orderId: order.id,
            source: 'CREATE',
            status: ShipmentStatus.FAILED,
            providerStatusCode: code,
            providerStatusDescription: message,
            location: null,
            occurredAt: new Date(),
          rawPayload: this.toJsonValue(
            this.redactForAudit(error.responseBody ?? null),
          ),
          });
          await manager.getRepository(TrackingEventEntity).save(event);
        });
      } catch (persistenceError) {
        this.logFailure(order, context.requestId, 'FAILURE_PERSISTENCE_ERROR', persistenceError);
        throw persistenceError;
      }

      this.logFailure(order, context.requestId, code, error);
      if (
        error.statusCode === 200 ||
        (error.statusCode !== undefined &&
          error.statusCode >= 400 &&
          error.statusCode < 500 &&
          ![401, 403, 429].includes(error.statusCode))
      ) {
        throw new UnprocessableEntityException({
          code,
          message,
          details: [],
        });
      }
      throw new BadGatewayException({ code, message, details: [] });
    }
  }

  async processReservedBulkOrder(
    batchItemId: string,
    retryRateLimit: boolean,
  ): Promise<void> {
    // Claim the item and create its audit attempt in one transaction. A
    // duplicate BullMQ delivery sees PROCESSING or a terminal status and exits.
    const claimed = await this.dataSource.transaction(async (manager) => {
      const itemRepository = manager.getRepository(BulkOrderItemEntity);
      const item = await itemRepository.findOne({
        where: { id: batchItemId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!item || item.status !== 'PENDING') return null;
      if (!item.orderId) {
        throw new Error('A pending bulk item is missing its reserved order.');
      }

      const order = await manager.getRepository(OrderEntity).findOne({
        where: { id: item.orderId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order || order.processingStatus !== 'CREATE_PENDING') {
        item.status = 'REQUIRES_RECONCILIATION';
        item.errorCode = 'ORDER_RESERVATION_INVALID';
        item.errorMessage = 'The reserved order is not ready for processing.';
        item.completedAt = new Date();
        await itemRepository.save(item);
        await this.refreshBatchCounts(manager, item.batchId);
        return null;
      }

      item.status = 'PROCESSING';
      item.attemptCount += 1;
      item.errorCode = null;
      item.errorMessage = null;
      await itemRepository.save(item);
      await manager.getRepository(BulkOrderBatchEntity).update(item.batchId, {
        status: 'PROCESSING',
        completedAt: null,
      });

      const attempt = await manager
        .getRepository(CourierOperationAttemptEntity)
        .save(
          manager.getRepository(CourierOperationAttemptEntity).create({
            orderId: order.id,
            operation: 'CREATE_SHIPMENT',
            outcome: 'STARTED',
            requestId: item.requestId,
            requestPayload: item.requestPayload,
            responsePayload: null,
            errorCode: null,
            errorMessage: null,
            completedAt: null,
          }),
        );
      return { item, order, attempt };
    });

    if (!claimed) return;

    // The adapter call is outside the database transaction so a slow courier
    // does not hold PostgreSQL locks or a connection while doing network I/O.
    let result: CreateShipmentResult;
    try {
      const courier = this.couriers.get(claimed.order.courierPartner);
      result = await courier.createShipment(
        this.toShipmentRequest(
          claimed.item.requestPayload as unknown as CreateOrderDto,
        ),
      );
    } catch (error) {
      const courierError = this.isCourierError(error) ? error : undefined;
      const shouldRetryRateLimit =
        retryRateLimit && courierError?.statusCode === 429;
      const ambiguous =
        !courierError ||
        courierError.statusCode === undefined ||
        courierError.statusCode >= 500;
      const safeMessage = 'The courier could not create this shipment.';

      // A 429 explicitly rejects the request, so a queue retry is safe. A
      // timeout, network failure, or 5xx may follow a successful manifest and
      // is held for reconciliation to avoid a duplicate shipment.
      await this.dataSource.transaction(async (manager) => {
        claimed.attempt.outcome = 'FAILED';
        claimed.attempt.errorCode =
          courierError?.code ?? 'COURIER_UNEXPECTED_ERROR';
        claimed.attempt.errorMessage = safeMessage;
        claimed.attempt.responsePayload = this.redactForAudit(
          courierError?.responseBody ?? null,
        );
        claimed.attempt.completedAt = new Date();
        await manager
          .getRepository(CourierOperationAttemptEntity)
          .save(claimed.attempt);

        if (shouldRetryRateLimit) {
          claimed.item.status = 'PENDING';
          claimed.item.errorCode = null;
          claimed.item.errorMessage = null;
          claimed.item.completedAt = null;
        } else {
          claimed.item.status = ambiguous
            ? 'REQUIRES_RECONCILIATION'
            : 'FAILED';
          claimed.item.errorCode =
            courierError?.code ?? 'COURIER_UNEXPECTED_ERROR';
          claimed.item.errorMessage = ambiguous
            ? 'Courier outcome is uncertain; reconcile before retrying.'
            : safeMessage;
          claimed.item.completedAt = new Date();

          claimed.order.processingStatus = 'CREATE_FAILED';
          claimed.order.shipmentStatus = ambiguous
            ? ShipmentStatus.UNKNOWN
            : ShipmentStatus.FAILED;
          claimed.order.lastErrorCode = claimed.item.errorCode;
          claimed.order.lastErrorMessage = claimed.item.errorMessage;
          await manager.getRepository(OrderEntity).save(claimed.order);

          const event = manager.getRepository(TrackingEventEntity).create({
            orderId: claimed.order.id,
            source: 'BULK_CREATE',
            status: claimed.order.shipmentStatus,
            providerStatusCode: claimed.item.errorCode,
            providerStatusDescription: claimed.item.errorMessage,
            location: null,
            occurredAt: new Date(),
            rawPayload: this.toJsonValue(
              this.redactForAudit(courierError?.responseBody ?? null),
            ),
            eventFingerprint: this.eventFingerprint({
              source: 'BULK_CREATE',
              status: claimed.order.shipmentStatus,
              code: claimed.item.errorCode,
              response: courierError?.responseBody ?? null,
            }),
          });
          await manager.getRepository(TrackingEventEntity).save(event);
        }

        await manager.getRepository(BulkOrderItemEntity).save(claimed.item);
        await this.refreshBatchCounts(manager, claimed.item.batchId);
      });

      this.logFailure(
        claimed.order,
        claimed.item.requestId,
        courierError?.code ?? 'COURIER_UNEXPECTED_ERROR',
        error,
      );

      // Throw only for a known-safe 429 retry; BullMQ applies exponential
      // backoff, while all other outcomes have already been persisted.
      if (shouldRetryRateLimit) throw error;
      return;
    }

    // Persist courier success, operation audit, history event, item outcome,
    // and aggregate counts atomically so polling never sees a split result.
    await this.dataSource.transaction(async (manager) => {
      claimed.order.processingStatus = 'CREATED';
      claimed.order.shipmentStatus = result.status;
      claimed.order.courierShipmentId = result.courierShipmentId;
      claimed.order.awbNumber = result.awbNumber;
      claimed.order.courierRequestPayload = result.rawRequest;
      claimed.order.courierResponsePayload = result.rawResponse;
      claimed.order.lastErrorCode = null;
      claimed.order.lastErrorMessage = null;
      await manager.getRepository(OrderEntity).save(claimed.order);

      claimed.attempt.outcome = 'SUCCEEDED';
      claimed.attempt.requestPayload = result.rawRequest;
      claimed.attempt.responsePayload = result.rawResponse;
      claimed.attempt.completedAt = new Date();
      await manager
        .getRepository(CourierOperationAttemptEntity)
        .save(claimed.attempt);

      const event = manager.getRepository(TrackingEventEntity).create({
        orderId: claimed.order.id,
        source: 'BULK_CREATE',
        status: result.status,
        providerStatusCode: null,
        providerStatusDescription: 'Shipment created',
        location: null,
        occurredAt: new Date(),
        rawPayload: this.toJsonValue(this.redactForAudit(result.rawResponse)),
        eventFingerprint: this.eventFingerprint({
          source: 'BULK_CREATE',
          status: result.status,
          rawPayload: result.rawResponse,
        }),
      });
      await manager.getRepository(TrackingEventEntity).save(event);

      claimed.item.status = 'SUCCEEDED';
      claimed.item.resultPayload = {
        id: claimed.order.id,
        order_id: claimed.order.externalOrderId,
        courier_partner: claimed.order.courierPartner,
        courier_shipment_id: claimed.order.courierShipmentId,
        awb_number: claimed.order.awbNumber,
        status: claimed.order.shipmentStatus,
      };
      claimed.item.errorCode = null;
      claimed.item.errorMessage = null;
      claimed.item.completedAt = new Date();
      await manager.getRepository(BulkOrderItemEntity).save(claimed.item);
      await this.refreshBatchCounts(manager, claimed.item.batchId);
    });
  }

  async getOrder(externalOrderId: string, client: AuthenticatedClient) {
    const order = await this.findTenantOrder(externalOrderId, client);
    const events = await this.dataSource.getRepository(TrackingEventEntity).find({
      where: { orderId: order.id },
      order: { occurredAt: 'ASC', recordedAt: 'ASC' },
    });
    const attempts = await this.attempts.find({
      where: { orderId: order.id },
      order: { createdAt: 'ASC' },
      select: {
        id: true,
        operation: true,
        outcome: true,
        errorCode: true,
        errorMessage: true,
        startedAt: true,
        completedAt: true,
      },
    });

    return {
      ...this.toResponse(order, false),
      processing_status: order.processingStatus,
      last_error: order.lastErrorCode
        ? { code: order.lastErrorCode, message: order.lastErrorMessage }
        : null,
      tracking_history: events.map((event) => this.toTrackingEvent(event)),
      operations: attempts.map((attempt) => ({
        operation_id: attempt.id,
        operation: attempt.operation,
        outcome: attempt.outcome,
        error_code: attempt.errorCode,
        error_message: attempt.errorMessage,
        started_at: attempt.startedAt,
        completed_at: attempt.completedAt,
      })),
    };
  }

  async track(
    externalOrderId: string,
    client: AuthenticatedClient,
    requestId: string,
  ) {
    const order = await this.findTenantOrder(externalOrderId, client);
    if (!order.awbNumber) {
      throw new ConflictException({
        code: 'SHIPMENT_REFERENCE_MISSING',
        message: 'This order does not have a courier AWB to track yet.',
      });
    }

    const courier = this.couriers.get(order.courierPartner);
    const reference = this.toCourierReference(order);
    const attempt = await this.startAttempt(
      order.id,
      'TRACK_SHIPMENT',
      requestId,
      reference,
    );

    let result: TrackShipmentResult;
    try {
      result = await courier.trackShipment(reference);
    } catch (error) {
      await this.completeFailedAttempt(order, attempt, requestId, error);
      throw this.toCourierHttpException(error);
    }

    const events = [...result.events];
    if (
      !events.some((event) => event.status === result.currentStatus)
    ) {
      events.push({
        status: result.currentStatus,
        providerStatusCode: result.currentStatusCode,
        providerStatusDescription: result.currentStatusDescription,
        occurredAt: result.fetchedAt,
        location: result.currentLocation,
        rawPayload: this.toJsonValue(this.redactForAudit(result.rawResponse)),
      });
    }

    await this.dataSource.transaction(async (manager) => {
      const nextStatus = this.statusAfterTracking(
        order.shipmentStatus,
        result.currentStatus,
      );
      if (nextStatus !== order.shipmentStatus) {
        await manager.getRepository(OrderEntity).update(order.id, {
          shipmentStatus: nextStatus,
        });
        order.shipmentStatus = nextStatus;
      }

      for (const event of events) {
        const fingerprint = this.eventFingerprint({
          status: event.status,
          providerStatusCode: event.providerStatusCode ?? null,
          providerStatusDescription: event.providerStatusDescription ?? null,
          location: event.location ?? null,
          occurredAt: event.occurredAt?.toISOString() ?? null,
          rawPayload: event.rawPayload,
        });
        await manager
          .createQueryBuilder()
          .insert()
          .into(TrackingEventEntity)
          .values({
            orderId: order.id,
            source: 'TRACKING',
            status: event.status,
            providerStatusCode: event.providerStatusCode ?? null,
            providerStatusDescription:
              event.providerStatusDescription ?? null,
            location: event.location ?? null,
            occurredAt: event.occurredAt,
            rawPayload: this.toJsonValue(this.redactForAudit(event.rawPayload)),
            eventFingerprint: fingerprint,
          })
          .orIgnore()
          .execute();
      }

      attempt.outcome = 'SUCCEEDED';
      attempt.requestPayload = result.rawRequest;
      attempt.responsePayload = result.rawResponse;
      attempt.completedAt = new Date();
      await manager.getRepository(CourierOperationAttemptEntity).save(attempt);
    });

    return {
      order_id: order.externalOrderId,
      courier_partner: order.courierPartner,
      awb_number: order.awbNumber,
      status: order.shipmentStatus,
      status_code: result.currentStatusCode ?? null,
      status_description: result.currentStatusDescription ?? null,
      current_location: result.currentLocation ?? null,
      expected_delivery_at: result.expectedDeliveryAt ?? null,
      fetched_at: result.fetchedAt,
      events: events.map((event) => ({
        status: event.status,
        status_code: event.providerStatusCode ?? null,
        status_description: event.providerStatusDescription ?? null,
        occurred_at: event.occurredAt,
        location: event.location ?? null,
      })),
    };
  }

  async cancel(
    externalOrderId: string,
    dto: CancelOrderDto,
    client: AuthenticatedClient,
    requestId: string,
  ) {
    const order = await this.findTenantOrder(externalOrderId, client);
    const requestedPartner = dto.courier_partner.trim().toLowerCase();
    if (requestedPartner !== order.courierPartner) {
      throw new BadRequestException({
        code: 'COURIER_PARTNER_MISMATCH',
        message: 'courier_partner must match the courier assigned to this order.',
      });
    }

    if (
      order.shipmentStatus === ShipmentStatus.CANCELLED ||
      order.shipmentStatus === ShipmentStatus.CANCEL_REQUESTED
    ) {
      return {
        order_id: order.externalOrderId,
        courier_partner: order.courierPartner,
        awb_number: order.awbNumber,
        status: order.shipmentStatus,
        cancellation_confirmed:
          order.shipmentStatus === ShipmentStatus.CANCELLED,
        idempotent_replay: true,//what is it?
      };
    }
    if (order.processingStatus === 'CANCEL_PENDING') {
      throw new ConflictException({
        code: 'CANCELLATION_IN_PROGRESS',
        message: 'Cancellation for this order is already in progress.',
      });
    }
    if (order.processingStatus === 'CANCEL_FAILED') {
      throw new ConflictException({
        code: 'CANCELLATION_REQUIRES_RECONCILIATION',
        message: 'The prior cancellation attempt requires reconciliation.',
      });
    }
    if (order.processingStatus !== 'CREATED' || !order.awbNumber) {
      throw new ConflictException({
        code: 'ORDER_NOT_CANCELLABLE',
        message: 'The order does not have a created shipment to cancel.',
      });
    }

    const courier = this.couriers.get(order.courierPartner);
    const reference = this.toCourierReference(order);
    const attempt = this.attempts.create({
      orderId: order.id,
      operation: 'CANCEL_SHIPMENT',
      outcome: 'STARTED',
      requestId,
      requestPayload: { courier_partner: requestedPartner, awb_number: order.awbNumber },
      responsePayload: null,
      errorCode: null,
      errorMessage: null,
      completedAt: null,
    });

    await this.dataSource.transaction(async (manager) => {
      const reservation = await manager.getRepository(OrderEntity).update(
        { id: order.id, processingStatus: 'CREATED' },
        { processingStatus: 'CANCEL_PENDING' },
      );
      if (reservation.affected !== 1) {
        throw new ConflictException({
          code: 'CANCELLATION_IN_PROGRESS',
          message: 'Cancellation for this order is already in progress.',
        });
      }
      order.processingStatus = 'CANCEL_PENDING';
      await manager.getRepository(CourierOperationAttemptEntity).save(attempt);
    });

    let result: CancelShipmentResult;
    try {
      result = await courier.cancelShipment(reference);
    } catch (error) {
      await this.completeFailedAttempt(order, attempt, requestId, error, true);
      throw this.toCourierHttpException(error);
    }

    const previousStatus = order.shipmentStatus;
    await this.dataSource.transaction(async (manager) => {
      // Order creation is complete; the courier's cancellation state belongs
      // in shipmentStatus, while processingStatus tracks the workflow operation.
      order.processingStatus = 'CREATED';
      order.shipmentStatus = result.status;
      order.lastErrorCode = null;
      order.lastErrorMessage = null;
      await manager.getRepository(OrderEntity).save(order);

      attempt.outcome = 'SUCCEEDED';
      attempt.requestPayload = result.rawRequest;
      attempt.responsePayload = result.rawResponse;
      attempt.completedAt = new Date();
      await manager.getRepository(CourierOperationAttemptEntity).save(attempt);

      if (result.status !== previousStatus) {
        const fingerprint = this.eventFingerprint({
          source: 'CANCEL',
          status: result.status,
          rawPayload: result.rawResponse,
        });
        await manager
          .createQueryBuilder()
          .insert()
          .into(TrackingEventEntity)
          .values({
            orderId: order.id,
            source: 'CANCEL',
            status: result.status,
            providerStatusCode: null,
            providerStatusDescription: result.cancellationConfirmed
              ? 'Cancellation confirmed'
              : 'Cancellation requested',
            location: null,
            occurredAt: new Date(),
            rawPayload: this.toJsonValue(this.redactForAudit(result.rawResponse)),
            eventFingerprint: fingerprint,
          })
          .orIgnore()
          .execute();
      }
    });

    return {
      order_id: order.externalOrderId,
      courier_partner: order.courierPartner,
      awb_number: order.awbNumber,
      status: order.shipmentStatus,
      cancellation_confirmed: result.cancellationConfirmed,
      idempotent_replay: false,
    };
  }

  private replayOrConflict(
    order: OrderEntity,
    dto: CreateOrderDto,
    partner: string,
  ) {
    if (
      order.courierPartner !== partner ||
      this.canonicalJson(order.requestPayload) !== this.canonicalJson(dto)
    ) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'This order_id was already used with a different request.',
      });
    }

    if (
      ['CREATED', 'CANCEL_PENDING', 'CANCEL_FAILED'].includes(
        order.processingStatus,
      )
    ) {
      this.logger.log(`Replaying idempotent request for order ${order.externalOrderId} with processing status ${order.processingStatus}.`,
      );
      return this.toResponse(order, true);
    }
    throw new ConflictException({
      code:
        order.processingStatus === 'CREATE_PENDING'
          ? 'ORDER_CREATION_IN_PROGRESS'
          : 'ORDER_REQUIRES_RECONCILIATION',
      message:
        order.processingStatus === 'CREATE_PENDING'
          ? 'Shipment creation for this order is still in progress.'
          : 'Shipment creation previously failed and requires reconciliation before retry.',
      details: [{ order_id: order.externalOrderId, internal_order_id: order.id }],
    });
  }

  private toShipmentRequest(dto: CreateOrderDto): CreateShipmentRequest {
    return {
      orderId: dto.order_id,
      serviceType: dto.service_type,
      paymentMode: dto.payment_mode,
      declaredValue: dto.declared_value,
      collectableValue: dto.collectable_value,
      item: { description: dto.item.description, quantity: dto.item.quantity },
      parcel: { ...dto.parcel },
      invoice: { ...dto.invoice },
      shipper: { ...dto.shipper },
      consignee: { ...dto.consignee },
      returnAddress: { ...dto.return_address },
    };
  }

  private async findTenantOrder(
    externalOrderId: string,
    client: AuthenticatedClient,
  ): Promise<OrderEntity> {
    const order = await this.orders.findOneBy({
      tenantId: client.tenantId,
      externalOrderId,
    });
    if (!order) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'No order with this order_id was found.',
      });
    }
    return order;
  }

  private toCourierReference(order: OrderEntity): CourierShipmentReference {
    return {
      orderId: order.externalOrderId,
      courierShipmentId: order.courierShipmentId,
      awbNumber: order.awbNumber,
    };
  }

  private async startAttempt(
    orderId: string,
    operation: 'TRACK_SHIPMENT' | 'CANCEL_SHIPMENT',
    requestId: string,
    requestPayload: unknown,
  ): Promise<CourierOperationAttemptEntity> {
    return this.attempts.save(
      this.attempts.create({
        orderId,
        operation,
        outcome: 'STARTED',
        requestId,
        requestPayload,
        responsePayload: null,
        errorCode: null,
        errorMessage: null,
        completedAt: null,
      }),
    );
  }

  private async completeFailedAttempt(
    order: OrderEntity,
    attempt: CourierOperationAttemptEntity,
    requestId: string,
    error: unknown,
    cancellation = false,
  ): Promise<void> {
    const courierError = this.isCourierError(error) ? error : undefined;
    const code = courierError?.code ?? 'COURIER_UNEXPECTED_ERROR';
    const safeMessage = 'The courier operation could not be completed.';
    await this.dataSource.transaction(async (manager) => {
      attempt.outcome = 'FAILED';
      attempt.errorCode = code;
      attempt.errorMessage = safeMessage;
      attempt.responsePayload = this.redactForAudit(
        courierError?.responseBody ?? null,
      );
      attempt.completedAt = new Date();
      await manager.getRepository(CourierOperationAttemptEntity).save(attempt);

      if (cancellation) {
        order.processingStatus = 'CANCEL_FAILED';
        order.lastErrorCode = code;
        order.lastErrorMessage = safeMessage;
        await manager.getRepository(OrderEntity).save(order);
      }
    });
    this.logFailure(order, requestId, code, error);
  }

  private toCourierHttpException(error: unknown): Error {
    if (!(error instanceof CourierApiError)) {
      return error instanceof Error
        ? error
        : new Error('Courier operation failed unexpectedly.');
    }

    const code = error.code;
    const message = 'The courier operation could not be completed.';
    if (
      error.statusCode === 200 ||
      (error.statusCode !== undefined &&
        error.statusCode >= 400 &&
        error.statusCode < 500 &&
        ![401, 403, 429].includes(error.statusCode))
    ) {
      return new UnprocessableEntityException({ code, message, details: [] });
    }
    return new BadGatewayException({ code, message, details: [] });
  }

  private statusAfterTracking(
    current: string | null,
    incoming: ShipmentStatus,
  ): string | null {
    if (incoming === ShipmentStatus.UNKNOWN) return current;
    const terminal = new Set([
      ShipmentStatus.DELIVERED,
      ShipmentStatus.CANCELLED,
      ShipmentStatus.RETURN_TO_ORIGIN,
    ]);
    if (current && terminal.has(current as ShipmentStatus) && current !== incoming) {
      return current;
    }
    return incoming;
  }

  private toTrackingEvent(event: TrackingEventEntity) {
    return {
      status: event.status,
      status_code: event.providerStatusCode,
      status_description: event.providerStatusDescription,
      location: event.location,
      occurred_at: event.occurredAt,
      recorded_at: event.recordedAt,
      source: event.source,
    };
  }

  private eventFingerprint(event: unknown): string {
    return createHash('sha256').update(this.canonicalJson(event)).digest('hex');
  }

  private async refreshBatchCounts(
    manager: EntityManager,
    batchId: string,
  ): Promise<void> {
    const batchRepository = manager.getRepository(BulkOrderBatchEntity);

    // Serialize aggregate updates on the batch row so concurrent workers do
    // not leave stale counts or a batch stuck in PROCESSING.
    const batch = await batchRepository.findOne({
      where: { id: batchId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!batch) return;

    const items = await manager
      .getRepository(BulkOrderItemEntity)
      .find({ where: { batchId } });
    const successCount = items.filter(
      (item) => item.status === 'SUCCEEDED',
    ).length;
    const failureCount = items.filter(
      (item) =>
        item.status === 'FAILED' ||
        item.status === 'REQUIRES_RECONCILIATION',
    ).length;
    const hasWork = items.some(
      (item) => item.status === 'PENDING' || item.status === 'PROCESSING',
    );

    batch.successCount = successCount;
    batch.failureCount = failureCount;
    batch.status = hasWork
      ? items.some((item) => item.status === 'PROCESSING')
        ? 'PROCESSING'
        : 'ACCEPTED'
      : failureCount > 0
        ? 'COMPLETED_WITH_ERRORS'
        : 'COMPLETED';
    batch.completedAt = hasWork ? null : new Date();
    await batchRepository.save(batch);
  }

  private toJsonValue(value: unknown): JsonPayload {
    if (value === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(value)) as JsonPayload;
    } catch {
      // Provider payloads are expected to be JSON-compatible; persist null if
      // an adapter unexpectedly returns a non-serializable value.
      return null;
    }
  }

  private toResponse(order: OrderEntity, replayed: boolean) {
    return {
      id: order.id,
      order_id: order.externalOrderId,
      courier_partner: order.courierPartner,
      courier_shipment_id: order.courierShipmentId,
      awb_number: order.awbNumber,
      status: order.shipmentStatus,
      created_at: order.createdAt,
      idempotent_replay: replayed,
    };
  }

  private canonicalJson(value: unknown): string {
    const sort = (item: unknown): unknown => {
      if (Array.isArray(item)) return item.map(sort);
      if (item !== null && typeof item === 'object') {
        return Object.fromEntries(
          Object.entries(item as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, sort(child)]),
        );
      }
      return item;
    };
    return JSON.stringify(sort(value));
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { code?: string }).code === '23505'
    );
  }

  private isCourierError(error: unknown): error is CourierApiError {
    return error instanceof CourierApiError;
  }

  private redactForAudit(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.redactForAudit(item));
    if (typeof value === 'string') {
      try {
        const url = new URL(value);
        for (const parameter of ['key', 'token', 'access_token', 'signature', 'sig', 'auth']) {
          if (url.searchParams.has(parameter)) url.searchParams.set(parameter, '[REDACTED]');
        }
        return url.toString();
      } catch {
        return value;
      }
    }
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        /password|access[_-]?token|authorization|cookie|secret|api[_-]?key/i.test(key)
          ? '[REDACTED]'
          : this.redactForAudit(child),
      ]),
    );
  }

  private logFailure(
    order: OrderEntity,
    requestId: string,
    errorType: string,
    error: unknown,
  ): void {
    this.logger.error(
      JSON.stringify({
        order_id: order.externalOrderId,
        courier_partner: order.courierPartner,
        request_id: requestId,
        error_type: errorType,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
  }
}
