import 'dotenv/config';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const pepper = process.env.API_KEY_PEPPER;

if (!databaseUrl) throw new Error('DATABASE_URL is required.');
if (!pepper || pepper.length < 32) {
  throw new Error('API_KEY_PEPPER must contain at least 32 characters.');
}

const tenantId = process.env.TENANT_ID ?? randomUUID();
const clientName = process.env.API_CLIENT_NAME ?? 'local-development';
const scopes = (process.env.API_CLIENT_SCOPES ?? 'orders:read,orders:write')
  .split(',')
  .map((scope) => scope.trim())
  .filter(Boolean);
const apiKey = `ec1_${randomBytes(32).toString('base64url')}`;
const keyHash = createHmac('sha256', pepper).update(apiKey).digest('hex');
const pool = new Pool({ connectionString: databaseUrl });

try {
  const result = await pool.query(
    `INSERT INTO api_clients (tenant_id, name, key_hash, scopes)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [tenantId, clientName, keyHash, scopes],
  );

  console.log(`API client ID: ${result.rows[0].id}`);
  console.log(`Tenant ID: ${tenantId}`);
  console.log(`Scopes: ${scopes.join(', ')}`);
  console.log('Save this API key now; it cannot be retrieved later:');
  console.log(apiKey);
} finally {
  await pool.end();
}
