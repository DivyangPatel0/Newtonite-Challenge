export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: any, headers?: Record<string, string>): Promise<T> {
  const opts: RequestInit = {
    method,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const err = data?.error || {};
    throw new ApiError(res.status, err.code || 'UNKNOWN', err.message || 'Request failed', err.details);
  }
  return data as T;
}

function idempotencyKey(): string {
  return crypto.randomUUID();
}

export const api = {
  auth: {
    login: (email: string, password: string) =>
      request<{ user: any }>('POST', '/api/auth/login', { email, password }),
    logout: () => request('POST', '/api/auth/logout'),
    me: () => request<any>('GET', '/api/auth/me'),
  },

  teams: {
    list: () => request<{ teams: any[] }>('GET', '/api/teams'),
    members: (teamId: string) => request<{ members: any[] }>('GET', `/api/teams/${teamId}/members`),
  },

  workItems: {
    list: (params: Record<string, string>) => {
      const qs = new URLSearchParams(params).toString();
      return request<{ items: any[]; next_cursor: string | null }>('GET', `/api/work-items?${qs}`);
    },
    get: (id: string) => request<any>('GET', `/api/work-items/${id}`),
    create: (data: any) =>
      request<any>('POST', '/api/work-items', data, { 'idempotency-key': idempotencyKey() }),
    patch: (id: string, data: any) =>
      request<any>('PATCH', `/api/work-items/${id}`, data, { 'idempotency-key': idempotencyKey() }),
    claim: (id: string) =>
      request<any>('POST', `/api/work-items/${id}/claim`, {}, { 'idempotency-key': idempotencyKey() }),
    transition: (id: string, data: { status: string; version: number }) =>
      request<any>('POST', `/api/work-items/${id}/transition`, data, { 'idempotency-key': idempotencyKey() }),
    assign: (id: string, data: { assignee_id: string | null; version: number }) =>
      request<any>('POST', `/api/work-items/${id}/assign`, data, { 'idempotency-key': idempotencyKey() }),
    approve: (id: string, data: { version: number }) =>
      request<any>('POST', `/api/work-items/${id}/approve`, data, { 'idempotency-key': idempotencyKey() }),
  },

  comments: {
    list: (workItemId: string, params: Record<string, string> = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request<{ items: any[]; next_cursor: string | null }>('GET', `/api/work-items/${workItemId}/comments?${qs}`);
    },
    create: (workItemId: string, body: string) =>
      request<any>('POST', `/api/work-items/${workItemId}/comments`, { body }, { 'idempotency-key': idempotencyKey() }),
  },

  events: {
    list: (workItemId: string, params: Record<string, string> = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request<{ items: any[]; next_cursor: string | null }>('GET', `/api/work-items/${workItemId}/events?${qs}`);
    },
  },

  notifications: {
    list: (params: Record<string, string> = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request<{ items: any[]; next_cursor: string | null; unread_count: number }>('GET', `/api/notifications?${qs}`);
    },
    markRead: (ids: string[]) =>
      request('POST', '/api/notifications/read', { notification_ids: ids }),
    markAllRead: () => request('POST', '/api/notifications/read-all'),
  },

  dashboard: {
    get: () => request<any>('GET', '/api/dashboard'),
  },
};
