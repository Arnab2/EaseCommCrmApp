import {
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { OrdersService } from '../orders/orders.service';
import { BulkOrdersService } from './bulk-orders.service';
import { BulkOrderItemEntity } from './entities/bulk-order-item.entity';
import { BULK_ORDERS_QUEUE, PROCESS_BULK_ORDER_JOB } from './bulk-orders.constants';

// Processor concurrency is decorator metadata, so read this once during boot.
const workerConcurrency = Number(
  process.env.BULK_WORKER_CONCURRENCY ?? 10,
);

@Injectable()
@Processor(BULK_ORDERS_QUEUE, { concurrency: workerConcurrency })
export class BulkOrderWorker extends WorkerHost {
  private readonly logger = new Logger(BulkOrderWorker.name);

  constructor(
    @InjectRepository(BulkOrderItemEntity)
    private readonly items: Repository<BulkOrderItemEntity>,
    private readonly orders: OrdersService,
    private readonly bulkOrders: BulkOrdersService,
  ) {
    super();
  }

  async process(job: Job<{ batch_item_id: string }>): Promise<void> {
    if (job.name !== PROCESS_BULK_ORDER_JOB) return;

    const itemId = job.data.batch_item_id;
    const item = await this.items.findOneBy({ id: itemId });
    if (!item || item.status !== 'PENDING') return;

    // BullMQ runs this handler concurrently up to workerConcurrency. Each item
    // carries its courier partner, and OrdersService selects that adapter.
    const configuredAttempts = job.opts.attempts ?? 1;
    const anotherQueueAttemptRemains =
      job.attemptsMade + 1 < configuredAttempts;

    // Only explicit courier 429 rejections are safe for queue-level retries.
    // Ambiguous manifest outcomes are persisted for reconciliation instead.
    await this.orders.processReservedBulkOrder(
      item.id,
      anotherQueueAttemptRemains,
    );
  }

  @OnWorkerEvent('failed')
  async onJobFailed(
    job: Job<{ batch_item_id: string }> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;

    // A job can exhaust queue-level retries before claiming its item. Persist
    // that outcome instead of leaving the batch pending forever.
    try {
      await this.bulkOrders.markUnclaimedItemFailed(
        job.data.batch_item_id,
        'Bulk worker could not start processing this order.',
        error,
      );
    } catch (persistenceError) {
      this.logger.error(
        JSON.stringify({
          event: 'bulk_job_failure_persistence_failed',
          job_id: job.id,
          error: persistenceError instanceof Error
            ? persistenceError.message
            : String(persistenceError),
          worker_error: error.message,
        }),
      );
    }
  }
}
