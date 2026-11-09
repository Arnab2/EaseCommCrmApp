export interface AuthenticatedClient {
  id: string;
  tenantId: string;
  name: string;
  scopes: string[];
}

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  authClient?: AuthenticatedClient;
  requestId?: string;
}
