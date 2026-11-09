import { randomUUID } from 'node:crypto';

interface RequestWithId {
  headers: Record<string, string | string[] | undefined>;
  requestId?: string;
}

interface ResponseWithHeaders {
  setHeader(name: string, value: string): void;
}

export class RequestIdMiddleware {
  use(
    request: RequestWithId,
    response: ResponseWithHeaders,
    next: () => void,
  ): void {
    const suppliedId = request.headers['x-request-id'];
    const validSuppliedId =
      typeof suppliedId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(suppliedId);

    request.requestId = validSuppliedId ? suppliedId : randomUUID();
    response.setHeader('x-request-id', request.requestId);
    next();
  }
}
