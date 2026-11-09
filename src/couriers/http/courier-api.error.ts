export class CourierApiError extends Error {
  constructor(
    readonly provider: string,
    readonly code: string,
    message: string,
    readonly options: {
      statusCode?: number;
      responseBody?: unknown;
      retryAfterMs?: number;
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'CourierApiError';
  }

  get statusCode(): number | undefined {
    return this.options.statusCode;
  }

  get responseBody(): unknown {
    return this.options.responseBody;
  }

  get retryAfterMs(): number | undefined {
    return this.options.retryAfterMs;
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }
}
