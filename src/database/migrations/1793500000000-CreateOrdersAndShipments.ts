import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrdersAndShipments1793500000000
  implements MigrationInterface
{
  name = 'CreateOrdersAndShipments1793500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        external_order_id varchar(120) NOT NULL,
        courier_partner varchar(60) NOT NULL,
        processing_status varchar(30) NOT NULL,
        shipment_status varchar(40),
        courier_shipment_id varchar(160),
        awb_number varchar(100),
        request_payload jsonb NOT NULL,
        courier_request_payload jsonb,
        courier_response_payload jsonb,
        last_error_code varchar(100),
        last_error_message text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_orders_tenant_external_id
          UNIQUE (tenant_id, external_order_id)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_orders_partner_awb
        ON orders (courier_partner, awb_number)
        WHERE awb_number IS NOT NULL
    `);
    await queryRunner.query(
      'CREATE INDEX ix_orders_tenant_created_at ON orders (tenant_id, created_at DESC)',
    );

    await queryRunner.query(`
      CREATE TABLE courier_operation_attempts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
        operation varchar(40) NOT NULL,
        outcome varchar(20) NOT NULL,
        request_id varchar(128) NOT NULL,
        request_payload jsonb,
        response_payload jsonb,
        error_code varchar(100),
        error_message text,
        started_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX ix_courier_attempts_order_created_at ON courier_operation_attempts (order_id, created_at DESC)',
    );

    await queryRunner.query(`
      CREATE TABLE tracking_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
        source varchar(30) NOT NULL,
        status varchar(40) NOT NULL,
        provider_status_code varchar(60),
        provider_status_description text,
        location varchar(240),
        occurred_at timestamptz,
        raw_payload jsonb,
        recorded_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX ix_tracking_events_order_occurred_at ON tracking_events (order_id, occurred_at DESC)',
    );
    await queryRunner.query(`
      CREATE FUNCTION reject_tracking_event_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'tracking_events is append-only';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_tracking_events_append_only
      BEFORE UPDATE OR DELETE ON tracking_events
      FOR EACH ROW EXECUTE FUNCTION reject_tracking_event_mutation()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE tracking_events');
    await queryRunner.query('DROP FUNCTION reject_tracking_event_mutation()');
    await queryRunner.query('DROP TABLE courier_operation_attempts');
    await queryRunner.query('DROP TABLE orders');
  }
}
