// Tiny fetch helper for the RBAC admin API. All requests are cookie-authed.
// Surfaces 401 / 403 as typed errors so the shell can render graceful screens.

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const BASE = '/api/rbac';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers || {}),
      },
      ...init,
    });
  } catch (e) {
    throw new ApiError(0, 'No se pudo conectar con el servidor.');
  }
  let data: any = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || res.statusText || 'Error';
    // Broadcast 401 so the shell can flip to the sign-in screen (session expiry).
    if (res.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('rbac-unauthorized'));
    }
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  del: <T>(p: string) => request<T>(p, { method: 'DELETE' }),
};

// ---- Domain types (per the API contract) ----
export type UserStatus = 'active' | 'suspended' | 'pending' | 'locked';

export interface UserRow {
  id: string;
  email: string;
  name?: string;
  preferred_name?: string;
  username?: string;
  job_title?: string;
  department_id?: string;
  employment_type?: string;
  status: UserStatus;
  last_login_ms?: number | null;
  roles: string[];
}

export interface UserDetail {
  user: UserRow;
  roles: { id: string; key: string; name: string }[];
  directPermissions: { perm_key: string; effect: 'allow' | 'deny' }[];
  effectivePermissions: string[];
}

export interface Role {
  id: string;
  key: string;
  name: string;
  description?: string;
  inherits: string[];
  is_system?: boolean;
  perms: string[];
}

export interface Permission {
  key: string;
  resource: string;
  action: string;
  label: string;
}

export interface Dashboard {
  users: { total: number; active: number; suspended: number; pending: number; locked: number; online: number };
  recentLogins: any[];
  permChanges: any[];
  failedLogins24h: number;
}

export const rbac = {
  dashboard: () => api.get<Dashboard>('/dashboard'),
  users: (q = '', status = '') =>
    api.get<{ users: UserRow[] }>(`/users?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`),
  user: (id: string) => api.get<UserDetail>(`/users/${id}`),
  suspend: (id: string, reason?: string) => api.post(`/users/${id}/suspend`, reason ? { reason } : {}),
  activate: (id: string) => api.post(`/users/${id}/activate`, {}),
  assignRole: (id: string, roleKey: string) => api.post(`/users/${id}/roles`, { roleKey }),
  removeRole: (id: string, roleId: string) => api.del(`/users/${id}/roles/${roleId}`),
  setPermission: (id: string, perm_key: string, effect: 'allow' | 'deny') =>
    api.post(`/users/${id}/permissions`, { perm_key, effect }),
  removePermission: (id: string, permKey: string) => api.del(`/users/${id}/permissions/${permKey}`),
  invite: (email: string, roleKey?: string) =>
    api.post<{ id: string; token: string }>('/invitations', roleKey ? { email, roleKey } : { email }),
  roles: () => api.get<{ roles: Role[] }>('/roles'),
  createRole: (r: Partial<Role>) => api.post<{ id: string }>('/roles', r),
  updateRole: (id: string, r: Partial<Role>) => api.patch(`/roles/${id}`, r),
  permissions: () => api.get<{ categories: Record<string, Permission[]> }>('/permissions'),
  audit: (limit = 100) => api.get<{ events: any[] }>(`/audit?limit=${limit}`),
  loginHistory: (limit = 100) => api.get<{ events: any[] }>(`/login-history?limit=${limit}`),
};
