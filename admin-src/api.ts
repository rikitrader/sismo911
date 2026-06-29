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
  put: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
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

  // ---- Wave 1 ----
  // Sessions, MFA, organization, feature flags, account lock. Some endpoints may
  // 404 until the wave-1 server deploy lands — callers handle that gracefully.
  lock: (id: string, reason?: string) => api.post(`/users/${id}/lock`, reason ? { reason } : {}),
  unlock: (id: string) => api.post(`/users/${id}/unlock`, {}),

  sessions: () => api.get<{ sessions: SessionRow[] }>(`/sessions`),
  userSessions: (id: string) => api.get<{ sessions: SessionRow[] }>(`/users/${id}/sessions`),
  userAudit: (id: string) => api.get<{ ok: boolean; opted_in: boolean; items: { id: string; action: string; detail: string; created_ms: number }[] }>(`/users/${id}/audit`),
  revokeSession: (token: string) => api.del(`/sessions/${encodeURIComponent(token)}`),
  revokeUserSession: (id: string, token: string) => api.del(`/users/${id}/sessions/${encodeURIComponent(token)}`),
  revokeAllUserSessions: (id: string) => api.post(`/users/${id}/sessions/revoke-all`, {}),

  mfaEnroll: () => api.post<MfaEnroll>(`/mfa/enroll`, {}),
  mfaVerify: (code: string) => api.post<MfaVerify>(`/mfa/verify`, { code }),
  mfaDisable: (code: string) => api.post(`/mfa/disable`, { code }),

  orgs: () => api.get<{ orgs: Org[] }>(`/orgs`),
  createOrg: (o: Partial<Org>) => api.post<{ id: string }>(`/orgs`, o),
  updateOrg: (id: string, o: Partial<Org>) => api.patch(`/orgs/${id}`, o),
  departments: (orgId?: string) => api.get<{ departments: Department[] }>(`/departments${orgId ? `?org_id=${encodeURIComponent(orgId)}` : ''}`),
  createDepartment: (d: Partial<Department>) => api.post<{ id: string }>(`/departments`, d),
  updateDepartment: (id: string, d: Partial<Department>) => api.patch(`/departments/${id}`, d),
  deleteDepartment: (id: string) => api.del(`/departments/${id}`),
  teams: (orgId?: string) => api.get<{ teams: Team[] }>(`/teams${orgId ? `?org_id=${encodeURIComponent(orgId)}` : ''}`),
  createTeam: (t: Partial<Team>) => api.post<{ id: string }>(`/teams`, t),
  updateTeam: (id: string, t: Partial<Team>) => api.patch(`/teams/${id}`, t),
  deleteTeam: (id: string) => api.del(`/teams/${id}`),
  addTeamMember: (id: string, userId: string) => api.post(`/teams/${id}/members`, { user_id: userId }),
  removeTeamMember: (id: string, userId: string) => api.del(`/teams/${id}/members/${userId}`),

  featureFlags: () => api.get<{ flags: FeatureFlag[] }>(`/feature-flags`),
  setFeatureFlag: (o: FeatureFlagOverride) => api.put(`/feature-flags`, o),
  removeFeatureFlag: (moduleKey: string, scopeType: string, scopeId: string) =>
    api.del(`/feature-flags/${encodeURIComponent(moduleKey)}/${encodeURIComponent(scopeType)}/${encodeURIComponent(scopeId)}`),
  featureFlagsEffective: (userId: string) =>
    api.get<{ effective: EffectiveFlag[] }>(`/feature-flags/effective?user_id=${encodeURIComponent(userId)}`),

  // ---- Wave 2 ----
  // Invitations / approvals, temporary roles, impersonation, role diff/export/import,
  // effective-permission inspection. Endpoints may 404 until the wave-2 server deploy
  // lands — callers degrade gracefully and never crash the shell.
  invitations: (status = '') =>
    api.get<{ invitations: Invitation[] }>(`/invitations${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  createInvitation: (b: { email: string; roleKey?: string; channel: InviteChannel; phone?: string }) =>
    api.post<Invitation>('/invitations', b),
  revokeInvitation: (id: string) => api.post(`/invitations/${id}/revoke`, {}),
  resendInvitation: (id: string) => api.post<Invitation>(`/invitations/${id}/resend`, {}),

  approvals: () => api.get<ApprovalsResp>(`/approvals`),
  approveUser: (id: string) => api.post(`/users/${id}/approve`, {}),
  rejectUser: (id: string, reason?: string) => api.post(`/users/${id}/reject`, reason ? { reason } : {}),

  tempRoles: (id: string) => api.get<TempRolesResp>(`/users/${id}/temp-roles`),
  addTempRole: (id: string, roleKey: string, expires_ms: number) =>
    api.post(`/users/${id}/temp-roles`, { roleKey, expires_ms }),
  removeTempRole: (id: string, roleId: string) => api.del(`/users/${id}/temp-roles/${roleId}`),

  impersonate: (userId: string, reason: string) => api.post(`/impersonate/${userId}`, { reason }),
  stopImpersonate: () => api.post(`/impersonate/stop`, {}),

  roleDiff: (id: string, perms: string[], inherits: string[]) =>
    api.post<RoleDiff>(`/roles/${id}/diff`, { perms, inherits }),
  exportRoles: () => api.get<RolesExport>(`/roles/export`),
  importRoles: (data: RolesExport) => api.post<ImportSummary>(`/roles/import`, data),

  effectivePermissions: (id: string) =>
    api.get<EffectivePermissions>(`/users/${id}/effective-permissions`),
};

// ---- Wave 1 domain types ----
export interface SessionRow {
  token: string;
  device_label?: string;
  user_agent?: string;
  ip?: string;
  ip_address?: string;
  created_ms?: number | null;
  last_seen_ms?: number | null;
  current?: boolean;
  is_current?: boolean;
}

export interface MfaEnroll { secret: string; otpauth_uri: string; }
export interface MfaVerify { backup_codes?: string[]; backupCodes?: string[]; }

export interface Org { id: string; key?: string; name: string; description?: string; }
export interface Department {
  id: string; org_id: string; parent_id?: string | null; name: string; description?: string;
}
export interface TeamMember { user_id: string; email?: string; name?: string; }
export interface Team {
  id: string; org_id: string; name: string; description?: string; members?: TeamMember[];
}

export type FlagScope = 'org' | 'role' | 'user' | 'global';
export interface FeatureFlagOverrideRow {
  scope_type: FlagScope; scope_id: string; scope_label?: string; enabled: boolean;
}
export interface FeatureFlag {
  module_key: string;
  label?: string;
  description?: string;
  module?: string;        // grouping key (module/category)
  default_enabled?: boolean;
  overrides?: FeatureFlagOverrideRow[];
}
export interface FeatureFlagOverride {
  module_key: string; scope_type: FlagScope; scope_id: string; enabled: boolean;
}
export interface EffectiveFlag { module_key: string; label?: string; enabled: boolean; source?: string; }

// ---- Wave 2 domain types ----
export type InviteChannel = 'email' | 'sms' | 'qr';
export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';
export interface Invitation {
  id: string;
  email: string;
  role_key?: string;
  roleKey?: string;
  channel?: InviteChannel;
  status?: InvitationStatus | string;
  link?: string;
  token?: string;
  phone?: string;
  created_ms?: number | null;
  expires_ms?: number | null;
  invited_by?: string;
}

// /approvals may return pending users under any of these shapes.
export interface ApprovalsResp { users?: UserRow[]; approvals?: UserRow[]; }

export interface TempRole {
  id: string;
  role_key?: string;
  roleKey?: string;
  key?: string;
  name?: string;
  expires_ms?: number | null;
  granted_ms?: number | null;
}
export interface TempRolesResp { tempRoles?: TempRole[]; temp_roles?: TempRole[]; roles?: TempRole[]; }

export interface RoleDiff {
  added: string[];
  removed: string[];
  inheritsAdded?: string[];
  inheritsRemoved?: string[];
}

export interface RolesExport { version: number | string; roles: any[]; }
export interface ImportSummary { created: number; updated: number; skipped: number; }

export interface EffectivePermissions {
  effective: string[];
  bySource: {
    roles: { role: string; perms: string[] }[];
    direct: { perm: string; effect: 'allow' | 'deny' }[];
    denied: string[];
  };
}
