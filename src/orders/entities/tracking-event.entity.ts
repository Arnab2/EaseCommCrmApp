import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

// PostgreSQL JSONB accepts objects, arrays, and scalar JSON values. Keeping
// this type non-recursive avoids excessive expansion in TypeORM's deep-partial
// query types.
export type JsonPayload = object | string | number | boolean | null;

@Entity({ name: 'tracking_events' })
@Index('ix_tracking_events_order_occurred_at', ['orderId', 'occurredAt'])
@Index('uq_tracking_events_fingerprint', ['orderId', 'eventFingerprint'], {
  unique: true,
  where: 'event_fingerprint IS NOT NULL',
})
export class TrackingEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  @Column({ name: 'source', type: 'varchar', length: 30 })
  source!: string;

  @Column({ name: 'status', type: 'varchar', length: 40 })
  status!: string;

  @Column({ name: 'provider_status_code', type: 'varchar', length: 60, nullable: true })
  providerStatusCode!: string | null;

  @Column({ name: 'provider_status_description', type: 'text', nullable: true })
  providerStatusDescription!: string | null;

  @Column({ name: 'location', type: 'varchar', length: 240, nullable: true })
  location!: string | null;

  @Column({ name: 'occurred_at', type: 'timestamptz', nullable: true })
  occurredAt!: Date | null;

  @Column({ name: 'raw_payload', type: 'jsonb', nullable: true })
  rawPayload!: JsonPayload;

  @Column({ name: 'event_fingerprint', type: 'char', length: 64, nullable: true })
  eventFingerprint!: string | null;

  @CreateDateColumn({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt!: Date;
}
