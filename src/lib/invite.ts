/**
 * Invitation lifecycle helpers (Phase 2 Wave 2 — USER LIFECYCLE).
 *
 * A privileged admin creates an invitation (email/sms/magic/qr channel); the
 * raw token is returned ONCE so the caller can email/text it or render a QR — we
 * only ever persist sha256hex(token). A new hire later accepts the token, which
 * provisions their account, assigns the invited role via user_roles, marks the
 * invitation accepted, and bumps the permission-cache epoch.
 *
 * Approval policy: if the org requires approval (feature_flags row
 * module_key='require_approval', enabled=1) the new account lands status='pending'
 * and an approval_requests row is queued; otherwise it is provisioned 'active'.
 */
import type { Env } from '../types';
import { uid } from './db';
import { randomToken, sha256hex } from './email';
import { hashPassword } from './auth';
import { bumpEpoch } from '../rbac/engine';

const ORG = 'org_sismo911';
const INVITE_TTL_MS = 7 * 86_400_000; // 7 days
const MIN_PASSWORD = 8;

export type InviteChannel = 'email' | 'sms' | 'magic' | 'qr' | 'csv';

function baseUrl(env: Env): string {
  return env.PUBLIC_BASE_URL || 'https://sismo911.com';
}

/** Public accept URL the FRONTEND renders (also encoded into the QR image). */
export function acceptLink(env: Env, token: string): string {
  return `${baseUrl(env)}/invite/accept?token=${token}`;
}

/** Org-level policy: does a freshly-accepted account need an approver before it
 *  goes active? Default false (no row) ⇒ auto-active. */
export async function requiresApproval(env: Env, orgId: string = ORG): Promise<boolean> {
  const r: any = await env.DB
    .prepare(`SELECT enabled FROM feature_flags WHERE org_id = ? AND module_key = 'require_approval'`)
    .bind(orgId).first().catch(() => null);
  return !!r && Number(r.enabled) === 1;
}

export interface CreateInviteOpts {
  email: string;
  roleKey?: string | null;
  deptId?: string | null;
  channel?: InviteChannel;
  phone?: string | null;
  invitedBy?: string | null;
}

/** Create a pending invitation (7-day expiry). Returns the raw token + accept
 *  link; only the hash is stored. */
export async function createInvitation(
  env: Env,
  opts: CreateInviteOpts,
): Promise<{ id: string; token: string; link: string; roleId: string | null }> {
  const email = String(opts.email || '').trim().toLowerCase();
  let roleId: string | null = null;
  if (opts.roleKey) {
    const r: any = await env.DB.prepare('SELECT id FROM rbac_roles WHERE key = ?').bind(opts.roleKey).first();
    roleId = r?.id ?? null;
  }
  const token = randomToken();
  const id = uid('inv');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO invitations
       (id, org_id, email, role_id, dept_id, token_hash, channel, status, invited_by, phone, expires_ms, created_ms)
     VALUES (?,?,?,?,?,?,?, 'pending', ?,?,?,?)`,
  ).bind(
    id, ORG, email, roleId, opts.deptId ?? null, await sha256hex(token),
    opts.channel || 'email', opts.invitedBy ?? null, opts.phone ?? null,
    now + INVITE_TTL_MS, now,
  ).run();
  return { id, token, link: acceptLink(env, token), roleId };
}

/** Raw invitation row for a token (any status). Internal — lets callers branch
 *  on revoked vs expired vs accepted. */
export async function findInvitationByToken(env: Env, token: string): Promise<any | null> {
  if (!token) return null;
  return env.DB.prepare('SELECT * FROM invitations WHERE token_hash = ?').bind(await sha256hex(token)).first();
}

/** A valid, pending, unexpired invitation — or null. Never leaks token_hash. */
export async function verifyInvitation(env: Env, token: string): Promise<any | null> {
  const inv = await findInvitationByToken(env, token);
  if (!inv) return null;
  if (inv.status !== 'pending') return null;
  if (Number(inv.expires_ms) < Date.now()) return null;
  return inv;
}

export interface AcceptResult {
  ok: boolean;
  userId?: string;
  pending?: boolean;
  error?: string;
  /** HTTP status the route should surface on failure. */
  code?: number;
}

/** Accept an invitation: provision the user, assign the invited role, mark the
 *  invitation accepted, bump the perm epoch. Returns pending:true when the org
 *  requires approval (account lands status='pending'). */
export async function acceptInvitation(
  env: Env,
  token: string,
  opts: { name: string; password: string },
): Promise<AcceptResult> {
  const inv: any = await findInvitationByToken(env, token);
  if (!inv) return { ok: false, error: 'invalid_token', code: 400 };
  if (inv.status === 'revoked') return { ok: false, error: 'invitation_revoked', code: 400 };
  if (inv.status === 'accepted') return { ok: false, error: 'already_accepted', code: 400 };
  if (inv.status !== 'pending') return { ok: false, error: 'invitation_invalid', code: 400 };
  if (Number(inv.expires_ms) < Date.now()) {
    await env.DB.prepare(`UPDATE invitations SET status = 'expired' WHERE id = ?`).bind(inv.id).run().catch(() => {});
    return { ok: false, error: 'invitation_expired', code: 410 };
  }

  const name = String(opts.name || '').trim();
  const password = String(opts.password || '');
  if (!name) return { ok: false, error: 'name_required', code: 400 };
  if (password.length < MIN_PASSWORD) return { ok: false, error: 'password_too_short', code: 400 };

  const email = String(inv.email || '').trim().toLowerCase();
  if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first())
    return { ok: false, error: 'email_taken', code: 409 };

  const orgId = inv.org_id || ORG;
  const needApproval = await requiresApproval(env, orgId);
  const status = needApproval ? 'pending' : 'active';

  // Keep the legacy users.role coherent with the invited RBAC role so the coarse
  // fast-path gate stays correct. SECURITY (audit H5): when approval is required,
  // the account stays a privilege-less 'citizen' until an approver activates it —
  // the privileged legacy role + the user_roles grant are DEFERRED to approval.
  let legacyRole = 'citizen';
  if (inv.role_id && !needApproval) {
    const r: any = await env.DB.prepare('SELECT key FROM rbac_roles WHERE id = ?').bind(inv.role_id).first();
    if (r?.key === 'super_admin') legacyRole = 'admin';
    else if (r?.key === 'operator') legacyRole = 'operator';
  }

  const id = uid('usr');
  const now = Date.now();
  const { hash, salt } = await hashPassword(password);
  await env.DB.prepare(
    `INSERT INTO users (id,email,name,role,pw_hash,pw_salt,status,org_id,department_id,created_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, email, name, legacyRole, hash, salt, status, orgId, inv.dept_id ?? null, now).run();

  // SECURITY (audit H5): only grant the role immediately when no approval is needed.
  // When approval is required, the grant is deferred to /users/:id/approve.
  if (inv.role_id && !needApproval) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO user_roles (user_id, role_id, scope_dept_id, granted_by, granted_ms) VALUES (?,?,?,?,?)',
    ).bind(id, inv.role_id, inv.dept_id ?? null, inv.invited_by ?? null, now).run();
  }

  await env.DB.prepare(`UPDATE invitations SET status = 'accepted', accepted_ms = ? WHERE id = ?`).bind(now, inv.id).run();

  if (needApproval) {
    await env.DB.prepare(
      `INSERT INTO approval_requests (id, user_id, requested_role_id, status, created_ms) VALUES (?,?,?, 'pending', ?)`,
    ).bind(uid('apr'), id, inv.role_id ?? null, now).run();
  }

  await bumpEpoch(env, id);
  return { ok: true, userId: id, pending: needApproval };
}
