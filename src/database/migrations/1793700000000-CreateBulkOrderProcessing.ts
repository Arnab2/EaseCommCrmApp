import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBulkOrderProcessing1793700000000
  implements MigrationInterface
{
  name = 'CreateBulkOrderProcessing1793700000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE bulk_order_batches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        status varchar(30) NOT NULL,
        total_count integer NOT NULL CHECK (total_count BETWEEN 1 AND 100),
        success_count integer NOT NULL DEFAULT 0,
        failure_count integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz
      )
    `);
    await queryRunner.query(
      'CREATE INDEX ix_bulk_order_batches_tenant_created_at ON bulk_order_batches (tenant_id, created_at DESC)',
    );

    await queryRunner.query(`
      CREATE TABLE bulk_order_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_id uuid NOT NULL REFERENCES bulk_order_batches(id) ON DELETE RESTRICT,
        external_order_id varchar(120) NOT NULL,
        courier_partner varchar(60) NOT NULL,
        order_id uuid REFERENCES orders(id) ON DELETE RESTRICT,
        status varchar(40) NOT NULL,
        request_payload jsonb NOT NULL,
        result_payload jsonb,
        request_id varchar(128) NOT NULL,
        attempt_count integer NOT NULL DEFAULT 0,
        error_code varchar(100),
        error_message text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        CONSTRAINT uq_bulk_order_items_batch_order UNIQUE (batch_id, external_order_id)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX ix_bulk_order_items_status_updated_at ON bulk_order_items (status, updated_at)',
    );

    await queryRunner.query(`
      CREATE TABLE outbox_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type varchar(80) NOT NULL,
        aggregate_id uuid NOT NULL REFERENCES bulk_order_items(id) ON DELETE RESTRICT,
        payload jsonb NOT NULL,
        publish_attempts integer NOT NULL DEFAULT 0,
        published_at timestamptz,
        locked_until timestamptz,
        locked_by varchar(120),
        last_error_code varchar(100),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX ix_outbox_events_unpublished ON outbox_events (published_at, locked_until, created_at)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE outbox_events');
    await queryRunner.query('DROP TABLE bulk_order_items');
    await queryRunner.query('DROP TABLE bulk_order_batches');
  }
}
