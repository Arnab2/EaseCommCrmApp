# EaseCommerce Multi-Courier Platform

Courier-agnostic shipment integration API built with NestJS and TypeScript.

## Local setup

1. Install Node.js (maintained LTS) and Docker Desktop.
2. Copy `.env.example` to `.env` and replace `API_KEY_PEPPER` with a random secret of at least 32 characters.
3. Start PostgreSQL and Redis with `docker compose up -d postgres redis`.
4. Install dependencies with `npm install`.
5. Run database migrations with `npm run db:migrate`.
6. Create an API client with `npm run auth:provision`. Save the printed API key; it is only shown once. `TENANT_ID` and `API_CLIENT_NAME` can be set in `.env` to use a chosen tenant and client name.
7. Start the API in watch mode with `npm run start:dev`.

The API uses the `/api/v1` prefix and expects the consumer key in the `x-api-key` header. Endpoints are protected by default; mark intentional public routes with `@Public()`. Use `@RequireScopes()` to restrict a route to client scopes and `@CurrentClient()` to access the authenticated tenant/client.

Errors use `{ "error": { "code", "message", "request_id", "details" } }`. The request ID is returned in the `x-request-id` response header and included in server-side error logs.

Database schema changes use TypeORM migrations; automatic schema synchronization is disabled. To revoke a client, set its `is_active` field to `false` in `api_clients`.

## Orders

`POST /api/v1/orders` creates a shipment for one normalized order. It requires the `orders:write` scope. The consumer's `order_id` is idempotent within its tenant: repeating an identical successful request returns the stored result, while reusing the ID with a different body returns `409`. A request already in progress, or one whose courier outcome needs reconciliation, also returns `409` rather than risking a duplicate shipment. Courier failures are persisted with the operation record and can be reconciled later.

Other single-order endpoints:

- `GET /api/v1/orders/{order_id}` returns the stored order, status history, and operation summaries. Requires `orders:read`.
- `GET /api/v1/orders/{order_id}/track` pulls the current courier status and scan history, updates the stored status, and appends new scan events. Repeated scans are deduplicated by a stable event fingerprint. Requires `orders:track`.
- `POST /api/v1/orders/{order_id}/cancel` accepts `{ "courier_partner": "urbanebolt" }`, checks it matches the partner assigned to the order, and requests cancellation. Confirmed cancellations and pending cancellation requests are idempotent. Failed/ambiguous cancellation attempts require reconciliation before another attempt. Requires `orders:cancel`.

The order is reserved in PostgreSQL before contacting the courier. `orders` stores the normalized request, selected partner, courier references, current status, and redacted provider request/response. `courier_operation_attempts` records create, track, and cancel calls with outcomes. `tracking_events` stores status history as append-only rows; shipment creation writes the initial event. Courier HTTP retries remain governed by the courier HTTP client policy.

## Bulk orders

`POST /api/v1/orders/bulk` accepts an `orders` array of 1–100 normalized order payloads and returns `202 Accepted` with a `batch_id` and `status_url`. It requires `orders:write`. Each array entry has the same fields and validation rules as `POST /api/v1/orders`; entries may use different `courier_partner` values. Duplicate `order_id` values inside one request and unknown courier partners are rejected with HTTP 400 before any batch is saved.

The API commits the batch, its per-order items, tenant-scoped order reservations, and transactional outbox events together in PostgreSQL. Submission uses set-based inserts for the order reservations, batch items, and outbox rows, plus one locked lookup to resolve existing IDs; it does not issue one insert/select sequence per order. A background publisher moves outbox events to BullMQ/Redis. Each worker instance processes up to `BULK_WORKER_CONCURRENCY` jobs at once, and each item selects its courier through the registry. The concurrency limit is shared across couriers within one worker instance; if the application runs multiple instances, their limits add together. Set the worker concurrency with courier rate limits in mind. Poll `GET /api/v1/orders/bulk/{batch_id}` (requires `orders:read`) for item outcomes and aggregate counts. Batch states are `ACCEPTED`, `PROCESSING`, `COMPLETED`, and `COMPLETED_WITH_ERRORS`; each item is `PENDING`, `PROCESSING`, `SUCCEEDED`, `FAILED`, or `REQUIRES_RECONCILIATION`.

The `orders` unique key `(tenant_id, external_order_id)` prevents duplicate shipments across single and bulk submissions. An identical previously completed order is returned as an idempotent success; reusing its ID with a different payload is a per-item failure. A duplicate still in progress is reported as a per-item failure and does not create another shipment. Courier 429 responses may be retried by BullMQ with exponential backoff. A timeout, network failure, or 5xx during shipment creation can mean the courier accepted the manifest without returning its response, so the order is marked `REQUIRES_RECONCILIATION` instead of risking a duplicate create. Definite courier 4xx failures are recorded as failed items. The outbox closes the PostgreSQL/Redis dual-write gap; stable BullMQ job IDs and worker-side item claims make duplicate publication safe.

Local development starts both dependencies with `docker compose up -d postgres redis`. The bulk queue settings are configurable with `REDIS_URL`, `BULK_WORKER_CONCURRENCY`, `BULK_OUTBOX_POLL_INTERVAL_MS`, `BULK_OUTBOX_BATCH_SIZE`, `BULK_OUTBOX_LEASE_MS`, and `BULK_ITEM_STALE_AFTER_MS` in `.env`. A worker that stops after claiming an item leaves an auditable `REQUIRES_RECONCILIATION` result after the stale-item threshold; it is never automatically resubmitted to a courier.

Example submission (save a complete valid order object using the single-order example above as each array entry):

```sh
curl -X POST http://localhost:3000/api/v1/orders/bulk \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_API_KEY' \
  -H 'x-request-id: bulk-create-2026-001' \
  -d '{"orders":[{"order_id":"BULK-1001","courier_partner":"mock","service_type":"SURFACE","payment_mode":"PREPAID","declared_value":1200,"collectable_value":0,"item":{"description":"T-shirt","quantity":1},"parcel":{"pieces":1,"weightKg":0.5,"lengthCm":20,"breadthCm":15,"heightCm":5},"invoice":{"number":"INV-1001","date":"2026-11-03","value":1200},"shipper":{"name":"Sender","phone":"+919900000000","addressLine1":"1 Main Road","city":"Gurgaon","state":"Haryana","country":"India","postalCode":"122001"},"consignee":{"name":"Buyer","phone":"+918800000000","addressLine1":"2 Park Road","city":"Delhi","state":"Delhi","country":"India","postalCode":"110001"},"return_address":{"name":"Returns","phone":"+919900000000","addressLine1":"1 Main Road","city":"Gurgaon","state":"Haryana","country":"India","postalCode":"122001"}}]}'

curl http://localhost:3000/api/v1/orders/bulk/BATCH_UUID \
  -H 'x-api-key: YOUR_API_KEY'
```

Example request (replace values with valid shipment data):

```json
{
  "order_id": "ORDER-1001",
  "courier_partner": "mock",
  "service_type": "SURFACE",
  "payment_mode": "PREPAID",
  "declared_value": 1200,
  "collectable_value": 0,
  "item": { "description": "T-shirt", "quantity": 1 },
  "parcel": { "pieces": 1, "weightKg": 0.5, "lengthCm": 20, "breadthCm": 15, "heightCm": 5 },
  "invoice": { "number": "INV-1001", "date": "2026-11-03", "value": 1200 },
  "shipper": { "name": "Sender", "phone": "+919900000000", "addressLine1": "1 Main Road", "city": "Gurgaon", "state": "Haryana", "country": "India", "postalCode": "122001" },
  "consignee": { "name": "Buyer", "phone": "+918800000000", "addressLine1": "2 Park Road", "city": "Delhi", "state": "Delhi", "country": "India", "postalCode": "110001" },
  "return_address": { "name": "Returns", "phone": "+919900000000", "addressLine1": "1 Main Road", "city": "Gurgaon", "state": "Haryana", "country": "India", "postalCode": "122001" }
}
```

```sh
curl -X POST http://localhost:3000/api/v1/orders \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_API_KEY' \
  -H 'x-request-id: order-create-1001' \
  -d @order.json
```

```sh
curl http://localhost:3000/api/v1/orders/ORDER-1001 \
  -H 'x-api-key: YOUR_API_KEY'

curl http://localhost:3000/api/v1/orders/ORDER-1001/track \
  -H 'x-api-key: YOUR_API_KEY'

curl -X POST http://localhost:3000/api/v1/orders/ORDER-1001/cancel \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_API_KEY' \
  -d '{"courier_partner":"mock"}'
```

## Couriers

`mock` is always available through the courier registry. To enable UrbaneBolt, set `URBANEBOLT_ENABLED=true` and provide its base URL, username, password, and customer code in `.env`. Never commit credentials or `.env` files.

The UrbaneBolt adapter maps the internal courier contract to the provider's manifest, AWB tracking, and cancellation requests. Tracking and token requests use configured timeout and retry settings. Manifest and cancellation requests are not automatically replayed after a timeout because the courier may have completed them before the connection failed; reconciliation will be handled by the order workflow.
