import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

interface HttpRequestContext {
  requestId?: string;
  method?: string;
  originalUrl?: string;
  url?: string;
}

interface HttpResponseContext {
  status(code: number): HttpResponseContext;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

type ErrorBody = Record<string, unknown>;

@Catch()
export class NormalizedExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(NormalizedExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequestContext>();
    const response = http.getResponse<HttpResponseContext>();
    const requestId = request.requestId ?? randomUUID();
    const statusCode =
      exception instanceof HttpException ? exception.getStatus() : 500;
    const body =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const errorBody = this.asRecord(body);
    const internalError = statusCode >= 500;

    const responseMessage = errorBody?.message;
    const message = internalError
      ? 'An unexpected error occurred.'
      : typeof responseMessage === 'string'
        ? responseMessage
        : 'The request could not be processed.';
    const details = this.getDetails(errorBody);
    const code =
      !internalError && typeof errorBody?.code === 'string'
        ? errorBody.code
        : this.codeForStatus(statusCode);

    if (internalError) {
      const stack = exception instanceof Error ? exception.stack : undefined;
      this.logger.error(
        JSON.stringify({
          requestId,
          method: request.method,
          path: request.originalUrl ?? request.url,
          statusCode,
          error: exception instanceof Error ? exception.message : String(exception),
          stack,
        }),
      );
    } else {
      this.logger.warn(
        JSON.stringify({
          requestId,
          method: request.method,
          path: request.originalUrl ?? request.url,
          statusCode,
          code,
        }),
      );
    }

    response.setHeader('x-request-id', requestId);
    response.status(statusCode).json({
      error: {
        code,
        message,
        request_id: requestId,
        details,
      },
    });
  }

  private asRecord(value: unknown): ErrorBody | undefined {
    return value !== null && typeof value === 'object'
      ? (value as ErrorBody)
      : undefined;
  }

  private getDetails(body?: ErrorBody): unknown[] {
    if (Array.isArray(body?.details)) return body.details;
    if (Array.isArray(body?.message)) {
      return body.message.map((message) => ({ message }));
    }
    return [];
  }

  private codeForStatus(statusCode: number): string {
    const codes: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'AUTHENTICATION_REQUIRED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      422: 'UNPROCESSABLE_ENTITY',
      429: 'RATE_LIMITED',
    };
    return codes[statusCode] ?? 'INTERNAL_ERROR';
  }
}
