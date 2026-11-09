import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BulkItemStatus } from '../bulk-orders.constants';

@Entity({ name: 'bulk_order_items' })
@Index('uq_bulk_order_items_batch_order', ['batchId', 'externalOrderId'], {
  unique: true,
})
@Index('ix_bulk_order_items_status_updated_at', ['status', 'updatedAt'])
export class BulkOrderItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'batch_id', type: 'uuid' })
  batchId!: string;

  @Column({ name: 'external_order_id', type: 'varchar', length: 120 })
  externalOrderId!: string;

  @Column({ name: 'courier_partner', type: 'varchar', length: 60 })
  courierPartner!: string;

  @Column({ name: 'order_id', type: 'uuid', nullable: true })
  orderId!: string | null;

  @Column({ type: 'varchar', length: 40 })
  status!: BulkItemStatus;

  @Column({ name: 'request_payload', type: 'jsonb' })
  requestPayload!: Record<string, unknown>;

  @Column({ name: 'result_payload', type: 'jsonb', nullable: true })
  resultPayload!: unknown;

  @Column({ name: 'request_id', type: 'varchar', length: 128 })
  requestId!: string;

  @Column({ name: 'attempt_count', type: 'integer', default: 0 })
  attemptCount!: number;

  @Column({ name: 'error_code', type: 'varchar', length: 100, nullable: true })
  errorCode!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
