export const configuration = () => ({
  app: {
    environment: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 3000),
  },
  database: {
    url: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true',
    poolMax: Number(process.env.DB_POOL_MAX ?? 10),
    connectTimeoutMs: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000),
    retryAttempts: Number(process.env.DB_RETRY_ATTEMPTS ?? 5),
    retryDelayMs: Number(process.env.DB_RETRY_DELAY_MS ?? 3000),
  },
  auth: {
    apiKeyPepper: process.env.API_KEY_PEPPER,
  },
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },
  bulkOrders: {
    workerConcurrency: Number(process.env.BULK_WORKER_CONCURRENCY ?? 10),
    outboxPollIntervalMs: Number(
      process.env.BULK_OUTBOX_POLL_INTERVAL_MS ?? 1000,
    ),
    outboxBatchSize: Number(process.env.BULK_OUTBOX_BATCH_SIZE ?? 50),
    outboxLeaseMs: Number(process.env.BULK_OUTBOX_LEASE_MS ?? 30000),
    itemStaleAfterMs: Number(
      process.env.BULK_ITEM_STALE_AFTER_MS ?? 900000,
    ),
  },
  courierHttp: {
    timeoutMs: Number(process.env.COURIER_TIMEOUT_MS ?? 10000),
    maxRetries: Number(process.env.COURIER_MAX_RETRIES ?? 3),
    retryBaseDelayMs: Number(process.env.COURIER_RETRY_BASE_DELAY_MS ?? 500),
    retryMaxDelayMs: Number(process.env.COURIER_RETRY_MAX_DELAY_MS ?? 5000),
  },
  couriers: {
    urbanebolt: {
      enabled: process.env.URBANEBOLT_ENABLED === 'true',
      baseUrl: process.env.URBANEBOLT_BASE_URL,
      username: process.env.URBANEBOLT_USERNAME,
      password: process.env.URBANEBOLT_PASSWORD,
      customerCode: process.env.URBANEBOLT_CUSTOMER_CODE,
      tokenRefreshBufferSeconds: Number(
        process.env.URBANEBOLT_TOKEN_REFRESH_BUFFER_SECONDS ?? 60,
      ),
      timezoneOffsetMinutes: Number(
        process.env.URBANEBOLT_TIMEZONE_OFFSET_MINUTES ?? 330,
      ),
    },
  },
});
