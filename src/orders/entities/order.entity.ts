import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type OrderProcessingStatus =
  | 'CREATE_PENDING'
  | 'CREATED'
  | 'CREATE_FAILED'
  | 'CANCEL_PENDING'
  | 'CANCEL_FAILED';

@Entity({ name: 'orders' })
@Index('uq_orders_tenant_external_id', ['tenantId', 'externalOrderId'], {
  unique: true,
})
@Index('uq_orders_partner_awb', ['courierPartner', 'awbNumber'], {
  unique: true,
  where: 'awb_number IS NOT NULL',
})
@Index('ix_orders_tenant_created_at', ['tenantId', 'createdAt'])
export class OrderEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'external_order_id', type: 'varchar', length: 120 })
  externalOrderId!: string;

  @Column({ name: 'courier_partner', type: 'varchar', length: 60 })
  courierPartner!: string;

  @Column({ name: 'processing_status', type: 'varchar', length: 30 })
  processingStatus!: OrderProcessingStatus;

  @Column({ name: 'shipment_status', type: 'varchar', length: 40, nullable: true })
  shipmentStatus!: string | null;

  @Column({ name: 'courier_shipment_id', type: 'varchar', length: 160, nullable: true })
  courierShipmentId!: string | null;

  @Column({ name: 'awb_number', type: 'varchar', length: 100, nullable: true })
  awbNumber!: string | null;

  @Column({ name: 'request_payload', type: 'jsonb' })
  requestPayload!: Record<string, unknown>;

  @Column({ name: 'courier_request_payload', type: 'jsonb', nullable: true })
  courierRequestPayload!: unknown;

  @Column({ name: 'courier_response_payload', type: 'jsonb', nullable: true })
  courierResponsePayload!: unknown;

  @Column({ name: 'last_error_code', type: 'varchar', length: 100, nullable: true })
  lastErrorCode!: string | null;

  @Column({ name: 'last_error_message', type: 'text', nullable: true })
  lastErrorMessage!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
