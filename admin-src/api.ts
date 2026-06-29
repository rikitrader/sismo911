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

async function request<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
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
    // Step-up: a sensitive admin mutation needs a recent password re-confirmation
    // (the acting admin enabled sec_require_login). Prompt once, then retry.
    if (res.status === 403 && data?.error === 'step_up_required' && !retried && typeof window !== 'undefined') {
      if (await stepUpPrompt()) return request<T>(path, init, true);
    }
    const msg = (data && (data.error || data.message)) || res.statusText || 'Error';
    // Broadcast 401 so the shell can flip to the sign-in screen (session expiry).
    if (res.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('rbac-unauthorized'));
    }
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

// Step-up password prompt (imperative DOM, styled with the console tokens). Posts
// to /api/profile/confirm; resolves true when the password is accepted.
let _stepUpPending: Promise<boolean> | null = null;
function stepUpPrompt(): Promise<boolean> {
  if (_stepUpPending) return _stepUpPending;
  _stepUpPending = new Promise<boolean>((resolve) => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgb(0 0 0 / .5);display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML = `<div style="background:rgb(var(--bg-elev));color:rgb(var(--text));border:1px solid rgb(var(--border));border-radius:12px;max-width:380px;width:100%;padding:22px;box-shadow:0 16px 48px -12px rgb(0 0 0 / .4)">
      <div style="font-weight:700;font-size:15px;margin-bottom:4px">Confirma tu identidad</div>
      <div style="font-size:13px;color:rgb(var(--text-muted));margin-bottom:14px">Esta acción es sensible. Ingresa tu contraseña para continuar.</div>
      <input type="password" autocomplete="current-password" placeholder="Contraseña" class="input" />
      <div class="err" style="display:none;color:#ef4444;font-size:12px;margin-top:8px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button type="button" class="btn btn-ghost cancel">Cancelar</button>
        <button type="button" class="btn btn-primary ok">Confirmar</button>
      </div></div>`;
    document.body.appendChild(ov);
    const inp = ov.querySelector('input') as HTMLInputElement;
    const err = ov.querySelector('.err') as HTMLElement;
    const ok = ov.querySelector('.ok') as HTMLButtonElement;
    const cancel = ov.querySelector('.cancel') as HTMLButtonElement;
    const done = (v: boolean) => { ov.remove(); _stepUpPending = null; resolve(v); };
    setTimeout(() => inp.focus(), 30);
    cancel.onclick = () => done(false);
    ov.addEventListener('click', (e) => { if (e.target === ov) done(false); });
    async function go() {
      if (!inp.value) { inp.focus(); return; }
      ok.disabled = true; ok.textContent = 'Verificando…'; err.style.display = 'none';
      try {
        const r = await fetch('/api/profile/confirm', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: inp.value }),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok) { done(true); return; }
        err.textContent = d.error === 'invalid_password' ? 'Contraseña incorrecta.' : 'No se pudo confirmar.';
        err.style.display = 'block'; ok.disabled = false; ok.textContent = 'Confirmar'; inp.select();
      } catch {
        err.textContent = 'Error de red.'; err.style.display = 'block';
        ok.disabled = false; ok.textContent = 'Confirmar';
      }
    }
    ok.onclick = go;
    inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  });
  return _stepUpPending;
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
