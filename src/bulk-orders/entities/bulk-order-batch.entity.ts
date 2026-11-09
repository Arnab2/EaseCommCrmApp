import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BulkBatchStatus } from '../bulk-orders.constants';

@Entity({ name: 'bulk_order_batches' })
@Index('ix_bulk_order_batches_tenant_created_at', ['tenantId', 'createdAt'])
export class BulkOrderBatchEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 30 })
  status!: BulkBatchStatus;

  @Column({ name: 'total_count', type: 'integer' })
  totalCount!: number;

  @Column({ name: 'success_count', type: 'integer', default: 0 })
  successCount!: number;

  @Column({ name: 'failure_count', type: 'integer', default: 0 })
  failureCount!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
