# Design Overview

## Architecture

The service is a NestJS modular monolith. `AppModule` composes focused modules for authentication, orders, bulk orders, couriers, configuration, and database access. Controllers handle the HTTP boundary and validation; services implement the workflows; TypeORM entities and migrations define the PostgreSQL persistence model.

Clients authenticate with an `x-api-key`. `ApiKeyGuard` asks `ApiClientsService` to HMAC-SHA256 hash the presented key with `API_KEY_PEPPER`, then looks up an active client and checks its scopes. The raw key is not stored. The authenticated client supplies the tenant ID used to scope order and batch operations.

Single order creation is synchronous: the service reserves the tenant/order ID, calls the selected courier, then stores the result and operation history. Bulk creation is asynchronous. In one PostgreSQL transaction it reserves orders, creates a batch and item rows, and writes outbox events. `BulkOutboxPublisher` leases unpublished events and places jobs on BullMQ/Redis; `BulkOrderWorker` processes them. The database outbox allows publication to resume after Redis outages. Queue job IDs and database state checks help tolerate repeated delivery. Ambiguous courier outcomes are held for reconciliation rather than automatically retried, to avoid duplicate shipments.

## Design patterns

**Adapter plus registry (Strategy).** Each courier implements the common courier adapter contract. `CourierRegistry` selects an adapter by partner ID, while each adapter maps the shared shipment and tracking contracts to the provider API. This keeps order workflows independent of provider-specific field names and response formats, and makes it possible to add a courier without embedding its logic in the order service.

**Transactional outbox with worker queue.** Bulk order state and the event that schedules its processing are committed together in PostgreSQL. A polling publisher transfers committed work to BullMQ, and workers perform the courier calls outside database transactions. This avoids losing a job when the database commit succeeds but Redis is unavailable. It provides at-least-once delivery, so consumers and inserts are made idempotent where practical; it does not make the external courier call transactional.

## Database schema

- `api_clients`: tenant UUID, client name, unique HMAC key hash, scopes, active flag, and timestamps. There is no tenants table or tenant foreign key in this service; tenant IDs are supplied by the surrounding provisioning process.
- `orders`: one shipment reservation per `(tenant_id, external_order_id)`, courier partner, processing and shipment statuses, AWB/shipment references, request and provider payloads, and last error. AWBs are unique per courier when present.
- `courier_operation_attempts`: audit records for create, track, and cancel calls, including request ID, outcome, payloads, errors, and start/completion times.
- `tracking_events`: shipment status history with provider metadata, occurrence and recording times, and raw payload. A database trigger makes rows append-only. A partial unique index on `(order_id, event_fingerprint)` supports event deduplication.
- `bulk_order_batches` and `bulk_order_items`: tenant-scoped batch state and per-order processing state, request/result payloads, attempt counts, and errors. Batch size is constrained to 1 to 100. Items reference their batch and reserved order.
- `outbox_events`: durable work records with publish state, lease owner/expiry, attempt count, and last error. Workers publish only after the transaction that created these rows has committed.

## Trade-offs

- PostgreSQL is the source of truth; Redis/BullMQ provides scalable asynchronous execution. This adds a polling publisher, leases, and queue operations, but prevents bulk work from disappearing during a Redis outage.
- External courier calls cannot join the database transaction. A timeout or server error may mean the courier accepted a shipment even though this service did not receive confirmation. Such cases require operator reconciliation; this code intentionally does not guess and retry.
- JSONB payloads and operation attempts improve diagnostics and provider auditing, at the cost of storage and careful handling of personal or sensitive data. Some provider response and error payloads are redacted before persistence; request payloads may contain customer data and need appropriate retention and access controls.
- Tenant IDs are UUIDs without a local tenant relation, keeping this service decoupled from tenant provisioning. Referential integrity and tenant lifecycle are therefore owned outside this schema.
- API-key scopes support least-privilege access, while key hashing means credentials cannot be retrieved later; provisioning must reveal a key only once and use the same pepper as the running service.
