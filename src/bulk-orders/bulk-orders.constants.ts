export const BULK_ORDERS_QUEUE = 'bulk-orders';
export const PROCESS_BULK_ORDER_JOB = 'process-bulk-order';

export type BulkBatchStatus =
  | 'ACCEPTED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'COMPLETED_WITH_ERRORS';

export type BulkItemStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'REQUIRES_RECONCILIATION';
