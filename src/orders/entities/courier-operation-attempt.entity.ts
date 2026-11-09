import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type CourierOperation = 'CREATE_SHIPMENT' | 'TRACK_SHIPMENT' | 'CANCEL_SHIPMENT';
export type CourierOperationOutcome = 'STARTED' | 'SUCCEEDED' | 'FAILED';

@Entity({ name: 'courier_operation_attempts' })
@Index('ix_courier_attempts_order_created_at', ['orderId', 'createdAt'])
export class CourierOperationAttemptEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  @Column({ name: 'operation', type: 'varchar', length: 40 })
  operation!: CourierOperation;

  @Column({ name: 'outcome', type: 'varchar', length: 20 })
  outcome!: CourierOperationOutcome;

  @Column({ name: 'request_id', type: 'varchar', length: 128 })
  requestId!: string;

  @Column({ name: 'request_payload', type: 'jsonb', nullable: true })
  requestPayload!: unknown;

  @Column({ name: 'response_payload', type: 'jsonb', nullable: true })
  responsePayload!: unknown;

  @Column({ name: 'error_code', type: 'varchar', length: 100, nullable: true })
  errorCode!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'started_at', type: 'timestamptz' })
  startedAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
