import * as Joi from 'joi';

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),
  DATABASE_URL: Joi.string().uri({ scheme: ['postgres', 'postgresql'] }).required(),
  DATABASE_SSL: Joi.boolean().default(false),
  DB_POOL_MAX: Joi.number().integer().min(1).max(100).default(10),
  DB_CONNECT_TIMEOUT_MS: Joi.number().integer().min(100).default(5000),
  DB_RETRY_ATTEMPTS: Joi.number().integer().min(1).max(20).default(5),
  DB_RETRY_DELAY_MS: Joi.number().integer().min(100).default(3000),
  API_KEY_PEPPER: Joi.string().min(32).required(),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .default('redis://localhost:6379'),
  BULK_WORKER_CONCURRENCY: Joi.number().integer().min(1).max(100).default(10),
  BULK_OUTBOX_POLL_INTERVAL_MS: Joi.number().integer().min(100).default(1000),
  BULK_OUTBOX_BATCH_SIZE: Joi.number().integer().min(1).max(500).default(50),
  BULK_OUTBOX_LEASE_MS: Joi.number().integer().min(1000).default(30000),
  BULK_ITEM_STALE_AFTER_MS: Joi.number().integer().min(60000).default(900000),
  COURIER_TIMEOUT_MS: Joi.number().integer().min(100).max(120000).default(10000),
  COURIER_MAX_RETRIES: Joi.number().integer().min(0).max(10).default(3),
  COURIER_RETRY_BASE_DELAY_MS: Joi.number().integer().min(10).default(500),
  COURIER_RETRY_MAX_DELAY_MS: Joi.number().integer().min(10).default(5000),
  URBANEBOLT_ENABLED: Joi.boolean().default(false),
  URBANEBOLT_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .when('URBANEBOLT_ENABLED', { is: true, then: Joi.required() }),
  URBANEBOLT_USERNAME: Joi.string().when('URBANEBOLT_ENABLED', {
    is: true,
    then: Joi.required(),
  }),
  URBANEBOLT_PASSWORD: Joi.string().when('URBANEBOLT_ENABLED', {
    is: true,
    then: Joi.required(),
  }),
  URBANEBOLT_CUSTOMER_CODE: Joi.string().when('URBANEBOLT_ENABLED', {
    is: true,
    then: Joi.required(),
  }),
  URBANEBOLT_TOKEN_REFRESH_BUFFER_SECONDS: Joi.number()
    .integer()
    .min(0)
    .max(3600)
    .default(60),
  URBANEBOLT_TIMEZONE_OFFSET_MINUTES: Joi.number()
    .integer()
    .min(-720)
    .max(840)
    .default(330),
});
