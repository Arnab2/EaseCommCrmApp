import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuthenticatedClient } from '../auth/authenticated-client';
import { CourierRegistry } from '../couriers/courier.registry';
import { CreateOrderDto } from '../orders/dto/create-order.dto';
import { OrderEntity } from '../orders/entities/order.entity';
import { CreateBulkOrdersDto } from './dto/create-bulk-orders.dto';
import { BulkOrderBatchEntity } from './entities/bulk-order-batch.entity';
import { BulkOrderItemEntity } from './entities/bulk-order-item.entity';
import { BulkItemStatus } from './bulk-orders.constants';
import { CourierOperationAttemptEntity } from '../orders/entities/courier-operation-attempt.entity';
import { TrackingEventEntity } from '../orders/entities/tracking-event.entity';

@Injectable()
export class BulkOrdersService {
  constructor(
    @InjectRepository(BulkOrderBatchEntity)
    private readonly batches: Repository<BulkOrderBatchEntity>,
    @InjectRepository(BulkOrderItemEntity)
    private readonly items: Repository<BulkOrderItemEntity>,
    private readonly dataSource: DataSource,
    private readonly couriers: CourierRegistry,
  ) {}

  private readonly logger = new Logger(BulkOrdersService.name);

  async submit(
    dto: CreateBulkOrdersDto,
    client: AuthenticatedClient,
    requestId: string,
  ) {
    // Reject duplicate IDs and unsupported partners before opening the write
    // transaction so a malformed batch never leaves partial reservations.
    this.validateBatch(dto.orders);

    return this.dataSource.transaction(async (manager) => {
      const batchRepository = manager.getRepository(BulkOrderBatchEntity);
      const orderRepository = manager.getRepository(OrderEntity);
      const externalOrderIds = dto.orders.map((order) => order.order_id);

      // Reserve all fresh IDs in one ordered INSERT. ON CONFLICT handles
      // concurrent requests safely; sorting gives overlapping bulk requests
      // the same lock acquisition order and reduces deadlock risk.
      const reservationRows = dto.orders.map((order) => ({
        external_order_id: order.order_id,
        courier_partner: order.courier_partner.trim().toLowerCase(),
        request_payload: order,
      }));
      const insertedReservations = (await manager.query(
        `
          INSERT INTO orders (
            tenant_id, external_order_id, courier_partner,
            processing_status, shipment_status, courier_shipment_id,
            awb_number, request_payload, courier_request_payload,
            courier_response_payload, last_error_code, last_error_message
          )
          SELECT
            $1::uuid,
            reservation.external_order_id,
            reservation.courier_partner,
            'CREATE_PENDING', NULL, NULL, NULL, reservation.request_payload,
            NULL, NULL, NULL, NULL
          FROM jsonb_to_recordset($2::jsonb) AS reservation(
            external_order_id varchar(120),
            courier_partner varchar(60),
            request_payload jsonb
          )
          ORDER BY reservation.external_order_id
          ON CONFLICT (tenant_id, external_order_id) DO NOTHING
          RETURNING external_order_id
        `,
        [client.tenantId, JSON.stringify(reservationRows)],
      )) as Array<{ external_order_id: string }>;
      const newlyReservedIds = new Set(
        insertedReservations.map((reservation) => reservation.external_order_id),
      );

      // Fetch and lock the whole reservation set once. This resolves IDs that
      // lost an insert race and lets us compare their saved payloads safely.
      const reservedOrders = await orderRepository
        .createQueryBuilder('order')
        .setLock('pessimistic_write')
        .where('order.tenant_id = :tenantId', { tenantId: client.tenantId })
        .andWhere('order.external_order_id IN (:...externalOrderIds)', {
          externalOrderIds,
        })
        .orderBy('order.external_order_id', 'ASC')
        .getMany();
      const ordersByExternalId = new Map<string, OrderEntity>();
      for (const order of reservedOrders) {
        ordersByExternalId.set(order.externalOrderId, order);
      }

      // Resolve fresh reservations and idempotency conflicts in memory after
      // the single locked read, without issuing per-order SELECT statements.
      const itemPlans = dto.orders.map((orderDto) => {
        const partner = orderDto.courier_partner.trim().toLowerCase();
        const existing = ordersByExternalId.get(orderDto.order_id);
        if (!existing) {
          throw new Error(
            'Order reservation conflict did not resolve to an order.',
          );
        }

        let status: BulkItemStatus = 'PENDING';
        let resultPayload: unknown = null;
        let errorCode: string | null = null;
        let errorMessage: string | null = null;

        if (!newlyReservedIds.has(orderDto.order_id)) {
          const sameRequest =
            existing.courierPartner === partner &&
            this.canonicalJson(existing.requestPayload) ===
              this.canonicalJson(orderDto);

          if (!sameRequest) {
            status = 'FAILED';
            errorCode = 'IDEMPOTENCY_KEY_REUSED';
            errorMessage =
              'This order_id was already used with a different request.';
          } else if (
            ['CREATED', 'CANCEL_PENDING', 'CANCEL_FAILED'].includes(
              existing.processingStatus,
            )
          ) {
            status = 'SUCCEEDED';
            resultPayload = {
              id: existing.id,
              order_id: existing.externalOrderId,
              courier_partner: existing.courierPartner,
              courier_shipment_id: existing.courierShipmentId,
              awb_number: existing.awbNumber,
              status: existing.shipmentStatus,
              idempotent_replay: true,
            };
          } else if (existing.processingStatus === 'CREATE_PENDING') {
            status = 'FAILED';
            errorCode = 'ORDER_CREATION_IN_PROGRESS';
            errorMessage = 'This order_id is already being processed.';
          } else {// maybe CREATE_FAILED
            status = 'REQUIRES_RECONCILIATION';
            errorCode = 'ORDER_REQUIRES_RECONCILIATION';
            errorMessage =
              'The existing order requires reconciliation before retry.';
          }
        }

        return {
          id: randomUUID(),
          externalOrderId: orderDto.order_id,
          courierPartner: partner,
          orderId: existing.id,
          status,
          requestPayload: orderDto as unknown as Record<string, unknown>,
          resultPayload,
          requestId,
          attemptCount: 0,
          errorCode,
          errorMessage,
          completedAt: status === 'PENDING' ? null : new Date(),
        };
      });

      // Calculate initial totals from the resolved outcomes. Workers cannot
      // see these items until this transaction commits, so no reread is needed.
      const successCount = itemPlans.filter(
        (item) => item.status === 'SUCCEEDED',
      ).length;
      const failureCount = itemPlans.filter(
        (item) =>
          item.status === 'FAILED' ||
          item.status === 'REQUIRES_RECONCILIATION',
      ).length;
      const pendingCount = itemPlans.filter(
        (item) => item.status === 'PENDING',
      ).length;
      const completedAt = pendingCount === 0 ? new Date() : null;
      const batch = await batchRepository.save(
        batchRepository.create({
          tenantId: client.tenantId,
          status:
            pendingCount > 0
              ? 'ACCEPTED'
              : failureCount > 0
                ? 'COMPLETED_WITH_ERRORS'
                : 'COMPLETED',
          totalCount: dto.orders.length,
          successCount,
          failureCount,
          completedAt,
        }),
      );

      // Insert every batch item with one INSERT ... SELECT. IDs are generated
      // before the write so the matching outbox rows can also be inserted in
      // one statement without fetching the inserted items back.
      const itemInsertRows = itemPlans.map((item) => ({
        id: item.id,
        batch_id: batch.id,
        external_order_id: item.externalOrderId,
        courier_partner: item.courierPartner,
        order_id: item.orderId,
        status: item.status,
        request_payload: item.requestPayload,
        result_payload: item.resultPayload,
        request_id: item.requestId,
        attempt_count: item.attemptCount,
        error_code: item.errorCode,
        error_message: item.errorMessage,
        completed_at: item.completedAt,
      }));
      await manager.query(
        `
          INSERT INTO bulk_order_items (
            id, batch_id, external_order_id, courier_partner, order_id,
            status, request_payload, result_payload, request_id,
            attempt_count, error_code, error_message, completed_at
          )
          SELECT
            item.id, item.batch_id, item.external_order_id,
            item.courier_partner, item.order_id, item.status,
            item.request_payload, item.result_payload, item.request_id,
            item.attempt_count, item.error_code, item.error_message,
            item.completed_at
          FROM jsonb_to_recordset($1::jsonb) AS item(
            id uuid,
            batch_id uuid,
            external_order_id varchar(120),
            courier_partner varchar(60),
            order_id uuid,
            status varchar(40),
            request_payload jsonb,
            result_payload jsonb,
            request_id varchar(128),
            attempt_count integer,
            error_code varchar(100),
            error_message text,
            completed_at timestamptz
          )
        `,
        [JSON.stringify(itemInsertRows)],
      );

      // Publishable work is added to the outbox in one write. Redis publishing
      // remains asynchronous and happens only after the transaction commits.
      const pendingItemIds = itemPlans
        .filter((item) => item.status === 'PENDING')
        .map((item) => item.id);
      if (pendingItemIds.length > 0) {
        await manager.query(
          `
            INSERT INTO outbox_events (
              event_type, aggregate_id, payload, publish_attempts
            )
            SELECT
              'PROCESS_BULK_ORDER', pending.id,
              jsonb_build_object('batch_item_id', pending.id), 0
            FROM unnest($1::uuid[]) AS pending(id)
          `,
          [pendingItemIds],
        );
      }

      return {
        batch_id: batch.id,
        status: batch.status,
        total_count: batch.totalCount,
        success_count: batch.successCount,
        failure_count: batch.failureCount,
        status_url: `/api/v1/orders/bulk/${batch.id}`,
        created_at: batch.createdAt,
        items: itemPlans.map((item) => ({
          batch_item_id: item.id,
          order_id: item.externalOrderId,
          courier_partner: item.courierPartner,
          status: item.status,
          error_code: item.errorCode,
          error_message: item.errorMessage,
        })),
      };
    });
  }

  async getBatch(batchId: string, client: AuthenticatedClient) {
    // Validate UUID syntax before querying so malformed IDs return a clear 400.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(batchId)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'batch_id must be a UUID.',
        details: [{ field: 'batch_id', message: 'A valid UUID is required.' }],
      });
    }

    // Scope batch lookup by tenant so one API client cannot inspect another
    // tenant's orders or failure details.
    const batch = await this.batches.findOneBy({
      id: batchId,
      tenantId: client.tenantId,
    });
    if (!batch) {
      throw new NotFoundException({
        code: 'BATCH_NOT_FOUND',
        message: 'No bulk order batch with this batch_id was found.',
      });
    }

    const items = await this.items.find({
      where: { batchId: batch.id },
      order: { createdAt: 'ASC' },
    });
    return {
      batch_id: batch.id,
      status: batch.status,
      total_count: batch.totalCount,
      success_count: batch.successCount,
      failure_count: batch.failureCount,
      created_at: batch.createdAt,
      updated_at: batch.updatedAt,
      completed_at: batch.completedAt,
      items: items.map((item) => ({
        batch_item_id: item.id,
        order_id: item.externalOrderId,
        courier_partner: item.courierPartner,
        status: item.status,
        attempt_count: item.attemptCount,
        result: item.resultPayload,
        error: item.errorCode
          ? { code: item.errorCode, message: item.errorMessage }
          : null,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
        completed_at: item.completedAt,
      })),
    };
  }

  async recoverStaleItems(staleAfterMs: number): Promise<number> {
    const staleBefore = new Date(Date.now() - staleAfterMs);
    return this.dataSource.transaction(async (manager) => {
      const itemRepository = manager.getRepository(BulkOrderItemEntity);
      const staleItems = await itemRepository
        .createQueryBuilder('item')
        .where('item.status = :status', { status: 'PROCESSING' })
        .andWhere('item.updated_at < :staleBefore', { staleBefore })
        .orderBy('item.updated_at', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .take(100)
        .getMany();
      if (staleItems.length === 0) return 0;

      // A worker may have died after the courier accepted a manifest but
      // before PostgreSQL committed the result. Reconcile instead of replaying.
      for (const item of staleItems) {
        item.status = 'REQUIRES_RECONCILIATION';
        item.errorCode = 'BULK_ITEM_STALE';
        item.errorMessage =
          'Processing stopped before a final result was saved; reconcile before retrying.';
        item.completedAt = new Date();
        await itemRepository.save(item);

        // A stale claim may mean the courier accepted the shipment before the
        // worker stopped, so log enough context for safe manual reconciliation.
        this.logger.error(
          JSON.stringify({
            order_id: item.externalOrderId,
            courier_partner: item.courierPartner,
            request_id: item.requestId,
            error_type: item.errorCode,
          }),
        );

        if (!item.orderId) continue;
        const order = await manager
          .getRepository(OrderEntity)
          .findOneBy({ id: item.orderId });
        if (order?.processingStatus !== 'CREATE_PENDING') continue;

        order.processingStatus = 'CREATE_FAILED';
        order.shipmentStatus = 'UNKNOWN';
        order.lastErrorCode = item.errorCode;
        order.lastErrorMessage = item.errorMessage;
        await manager.getRepository(OrderEntity).save(order);

        await manager.getRepository(TrackingEventEntity).save(
          manager.getRepository(TrackingEventEntity).create({
            orderId: order.id,
            source: 'BULK_RECOVERY',
            status: 'UNKNOWN',
            providerStatusCode: item.errorCode,
            providerStatusDescription: item.errorMessage,
            location: null,
            occurredAt: new Date(),
            rawPayload: {
              batch_item_id: item.id,
              reason: 'stale_processing_lease',
            },
            eventFingerprint: null,
          }),
        );

        const attempt = await manager
          .getRepository(CourierOperationAttemptEntity)
          .createQueryBuilder('attempt')
          .where('attempt.order_id = :orderId', { orderId: order.id })
          .andWhere('attempt.operation = :operation', {
            operation: 'CREATE_SHIPMENT',
          })
          .andWhere('attempt.outcome = :outcome', { outcome: 'STARTED' })
          .orderBy('attempt.started_at', 'DESC')
          .getOne();
        if (attempt) {
          attempt.outcome = 'FAILED';
          attempt.errorCode = item.errorCode;
          attempt.errorMessage = item.errorMessage;
          attempt.completedAt = new Date();
          await manager
            .getRepository(CourierOperationAttemptEntity)
            .save(attempt);
        }
      }

      for (const batchId of new Set(staleItems.map((item) => item.batchId))) {
        await this.refreshBatchCounts(manager, batchId);
      }
      this.logger.warn(
        `Marked ${staleItems.length} stale bulk item(s) for reconciliation.`,
      );
      return staleItems.length;
    });
  }

  async markUnclaimedItemFailed(
    itemId: string,
    safeMessage = 'Bulk worker could not start processing this order.',
    cause?: unknown,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const itemRepository = manager.getRepository(BulkOrderItemEntity);
      const item = await itemRepository.findOne({
        where: { id: itemId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!item || item.status !== 'PENDING') return;

      item.status = 'FAILED';
      item.errorCode = 'BULK_WORKER_UNAVAILABLE';
      item.errorMessage = safeMessage;
      item.completedAt = new Date();
      await itemRepository.save(item);

      // Keep infrastructure failures searchable with the same identifying
      // fields as courier failures, while only returning the safe message to
      // the API consumer.
      this.logger.error(
        JSON.stringify({
          order_id: item.externalOrderId,
          courier_partner: item.courierPartner,
          request_id: item.requestId,
          error_type: item.errorCode,
          stack: cause instanceof Error ? cause.stack : undefined,
        }),
      );

      // No courier call was started for a still-PENDING item, so this failure
      // is known and can be recorded as FAILED rather than ambiguous.
      if (item.orderId) {
        const orderRepository = manager.getRepository(OrderEntity);
        const order = await orderRepository.findOneBy({ id: item.orderId });
        if (order?.processingStatus === 'CREATE_PENDING') {
          order.processingStatus = 'CREATE_FAILED';
          order.shipmentStatus = 'FAILED';
          order.lastErrorCode = item.errorCode;
          order.lastErrorMessage = item.errorMessage;
          await orderRepository.save(order);
        }
      }
      await this.refreshBatchCounts(manager, item.batchId);
    });
  }

  private validateBatch(orders: CreateOrderDto[]): void {
    const firstIndexByOrderId = new Map<string, number>();
    orders.forEach((order, index) => {
      const firstIndex = firstIndexByOrderId.get(order.order_id);
      if (firstIndex !== undefined) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          details: [
            {
              field: `orders.${index}.order_id`,
              message: `Duplicate order_id; it first appears at orders.${firstIndex}.order_id.`,
            },
          ],
        });
      }
      firstIndexByOrderId.set(order.order_id, index);

      // Resolve every adapter before creating any batch state. Unknown
      // partners reject the request with the registry's supported list.
      this.couriers.get(order.courier_partner);
    });
  }

  private async refreshBatchCounts(
    manager: EntityManager,
    batchId: string,
  ): Promise<void> {
    const itemRepository = manager.getRepository(BulkOrderItemEntity);
    const batchRepository = manager.getRepository(BulkOrderBatchEntity);
    // Serialize final count calculation with worker updates to other items.
    await batchRepository.findOne({
      where: { id: batchId },
      lock: { mode: 'pessimistic_write' },
    });
    const items = await itemRepository.find({ where: { batchId } });
    const successCount = items.filter((item) => item.status === 'SUCCEEDED').length;
    const failureCount = items.filter(
      (item) =>
        item.status === 'FAILED' ||
        item.status === 'REQUIRES_RECONCILIATION',
    ).length;
    const hasPending = items.some(
      (item) => item.status === 'PENDING' || item.status === 'PROCESSING',
    );
    const status = hasPending
      ? items.some((item) => item.status === 'PROCESSING')
        ? 'PROCESSING'
        : 'ACCEPTED'
      : failureCount > 0
        ? 'COMPLETED_WITH_ERRORS'
        : 'COMPLETED';

    await batchRepository.update(batchId, {
      successCount,
      failureCount,
      status,
      completedAt: hasPending ? null : new Date(),
    });
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
}
