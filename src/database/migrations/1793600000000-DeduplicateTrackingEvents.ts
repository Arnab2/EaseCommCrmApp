import { MigrationInterface, QueryRunner } from 'typeorm';

export class DeduplicateTrackingEvents1793600000000
  implements MigrationInterface
{
  name = 'DeduplicateTrackingEvents1793600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE tracking_events ADD COLUMN event_fingerprint char(64)',
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_tracking_events_fingerprint
        ON tracking_events (order_id, event_fingerprint)
        WHERE event_fingerprint IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX uq_tracking_events_fingerprint');
    await queryRunner.query(
      'ALTER TABLE tracking_events DROP COLUMN event_fingerprint',
    );
  }
}
