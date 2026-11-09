import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { BULK_ORDERS_QUEUE, PROCESS_BULK_ORDER_JOB } from './bulk-orders.constants';
import { OutboxEventEntity } from './entities/outbox-event.entity';
import { BulkOrdersService } from './bulk-orders.service';

@Injectable()
export class BulkOutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BulkOutboxPublisher.name);
  private readonly ownerId = `publisher-${randomUUID()}`;
  private readonly pollIntervalMs: number;
  private readonly claimSize: number;
  private readonly leaseMs: number;
  private readonly staleAfterMs: number;
  private timer?: NodeJS.Timeout;
  private active = false;
  private lastRecoveryAt = 0;

  constructor(
    @InjectRepository(OutboxEventEntity)
    private readonly outbox: Repository<OutboxEventEntity>,
    @InjectQueue(BULK_ORDERS_QUEUE)
    private readonly queue: Queue,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly bulkOrders: BulkOrdersService,
  ) {
    this.pollIntervalMs = config.get<number>(
      'bulkOrders.outboxPollIntervalMs',
      1000,
    );
    this.claimSize = config.get<number>('bulkOrders.outboxBatchSize', 50);
    this.leaseMs = config.get<number>('bulkOrders.outboxLeaseMs', 30000);
    this.staleAfterMs = config.get<number>(
      'bulkOrders.itemStaleAfterMs',
      900000,
    );
  }

  onModuleInit(): void {
    // Start a durable polling loop; an outbox row committed during a Redis
    // outage will be published after Redis becomes available again.
    console.log("Bulk Outbox Publisher started with poll interval:", this.pollIntervalMs, "ms, claim size:", this.claimSize, "lease:", this.leaseMs, "stale after:", this.staleAfterMs);
    this.timer = setInterval(() => void this.pollSafely(), this.pollIntervalMs);
    void this.pollSafely();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async pollSafely(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      await this.publishClaimedRows();

      // Old PROCESSING rows represent workers that stopped before writing a
      // final result. Mark them for reconciliation rather than re-enqueueing.
      if (Date.now() - this.lastRecoveryAt >= 60000) {
        await this.bulkOrders.recoverStaleItems(this.staleAfterMs);
        this.lastRecoveryAt = Date.now();
      }
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'bulk_outbox_poll_failed',
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }),
      );
    } finally {
      this.active = false;
    }
  }

  private async publishClaimedRows(): Promise<void> {
    const rows = await this.claimRows();
    for (const row of rows) {
      try {
        // The stable item UUID deduplicates overlapping publisher attempts.
        await this.queue.add(
          PROCESS_BULK_ORDER_JOB,
          row.payload,
          {
            jobId: row.aggregateId,
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: { age: 86400, count: 10000 },
            removeOnFail: { age: 604800, count: 10000 },
          },
        );
        await this.outbox.update(row.id, {
          publishedAt: new Date(),
          lockedUntil: null,
          lockedBy: null,
          lastErrorCode: null,
        });
      } catch (error) {
        // The lease lets another publisher take over after a crash; failures
        // release it immediately so the next poll can retry.
        await this.outbox.update(row.id, {
          lockedUntil: null,
          lockedBy: null,
          lastErrorCode: 'QUEUE_PUBLISH_FAILED',
        });
        this.logger.error(
          JSON.stringify({
            event: 'bulk_outbox_publish_failed',
            outbox_id: row.id,
            batch_item_id: row.aggregateId,
            stack: error instanceof Error ? error.stack : undefined,
          }),
        );
      }
    }
  }

  private async claimRows(): Promise<OutboxEventEntity[]> {
    return this.dataSource.transaction(async (manager) => {
      // SKIP LOCKED allows multiple application instances to publish different
      // outbox rows without holding a lock during Redis network calls.
      const rows = await manager
        .getRepository(OutboxEventEntity)
        .createQueryBuilder('event')
        .where('event.published_at IS NULL')
        .andWhere('(event.locked_until IS NULL OR event.locked_until < now())')
        .orderBy('event.created_at', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .take(this.claimSize)
        .getMany();

      const lockedUntil = new Date(Date.now() + this.leaseMs);
      for (const row of rows) {
        row.lockedBy = this.ownerId;
        row.lockedUntil = lockedUntil;
        row.publishAttempts += 1;
      }
      if (rows.length > 0) {
        await manager.getRepository(OutboxEventEntity).save(rows);
      }
      return rows;
    });
  }
}
