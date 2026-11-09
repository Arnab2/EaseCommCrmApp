import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateApiClients1793400000000 implements MigrationInterface {
  name = 'CreateApiClients1793400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE api_clients (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        name varchar(120) NOT NULL,
        key_hash char(64) NOT NULL,
        scopes text[] NOT NULL DEFAULT '{}',
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_api_clients_key_hash UNIQUE (key_hash)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX ix_api_clients_tenant_id ON api_clients (tenant_id)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE api_clients');
  }
}
