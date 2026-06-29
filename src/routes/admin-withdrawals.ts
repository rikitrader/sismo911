import { Hono } from 'hono';
import type { Env } from '../types';
import { audit } from '../lib/audit';
import { notify } from '../lib/notify';
import { requirePermission, currentUser } from '../rbac/middleware';

// Operator review of withdrawal requests. Mounted at /api/admin/withdrawals.
// Every route requires ops:console (held by the legacy operator + super_admin).
// Manual rails never auto-complete — an operator drives each state transition,
// which is the safety control while no licensed payout provider is integrated.

export const adminWithdrawals = new Hono<{ Bindings: Env }>();

function row(r: any) {
  return {
    id: r.id, user_id: r.user_id, method_type: r.method_type, amount_source: Number(r.amount_source) || 0,
    source_currency: r.source_currency, payout_currency: r.payout_currency, net_amount: Number(r.net_amount) || 0,
    destination_summary: r.destination_summary ?? null,
    destination: (() => { try { return r.destination_details_json ? JSON.parse(r.destination_details_json) : null; } catch { return null; } })(),
    status: r.status, risk_score: Number(r.risk_score) || 0, provider_reference: r.provider_reference ?? null,
    review_note: r.review_note ?? null, created_ms: r.created_ms, updated_ms: r.updated_ms, completed_ms: r.completed_ms ?? null,
  };
}

// GET /api/admin/withdrawals?status=pending_review — review queue.
adminWithdrawals.get('/', requirePermission('ops:console'), async (c) => {
  const status = c.req.query('status');
  const stmt = status
    ? c.env.DB.prepare(`SELECT * FROM withdrawal_requests WHERE status=? ORDER BY created_ms DESC LIMIT 500`).bind(status)
    : c.env.DB.prepare(`SELECT * FROM withdrawal_requests ORDER BY created_ms DESC LIMIT 500`);
  const { results } = await stmt.all();
  return c.json({ ok: true, requests: ((results ?? []) as any[]).map(row) });
});

async function transition(c: any, id: string, from: string[], to: string, extra: Record<string, unknown> = {}) {
  const cur: any = await c.env.DB.prepare(`SELECT id, status, user_id, net_amount, payout_currency FROM withdrawal_requests WHERE id=?`).bind(id).first();
  if (!cur) return { err: 'not_found' as const, code: 404 };
  if (!from.includes(cur.status)) return { err: 'bad_transition' as const, code: 409, status: cur.status };
  const now = Date.now();
  const sets = ['status=?', 'updated_ms=?']; const vals: unknown[] = [to, now];
  if (extra.review_note !== undefined) { sets.push('review_note=?'); vals.push(extra.review_note); }
  if (extra.provider_reference !== undefined) { sets.push('provider_reference=?'); vals.push(extra.provider_reference); }
  if (to === 'completed') { sets.push('completed_ms=?'); vals.push(now); }
  vals.push(id);
  await c.env.DB.prepare(`UPDATE withdrawal_requests SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
  return { ok: true as const, to, userId: cur.user_id as string, amount: Number(cur.net_amount) || 0, currency: cur.payout_currency as string };
}

// Notify the request owner about a status change (best-effort, never blocks the op).
async function notifyOwner(c: any, r: { userId: string; amount: number; currency: string }, title: string, body: string) {
  if (!r.userId) return;
  await notify(c.env, r.userId, { type: 'withdrawal_update', title, body, link: '#retiros' });
}

// PATCH /:id/approve — pending_review → processing.
adminWithdrawals.patch('/:id/approve', requirePermission('ops:console'), async (c) => {
  const r = await transition(c, c.req.param('id'), ['pending_review'], 'processing');
  if ('err' in r) return c.json({ error: r.err, status: (r as any).status }, r.code as any);
  await audit(c, 'withdrawal.approve', { id: c.req.param('id'), by: currentUser(c)?.id });
  await notifyOwner(c, r, 'Retiro aprobado', `Tu retiro de $${r.amount.toFixed(2)} ${r.currency || ''} fue aprobado y está en proceso.`);
  return c.json({ ok: true, status: 'processing' });
});

// PATCH /:id/reject — pending_review|processing → rejected (with a note).
adminWithdrawals.patch('/:id/reject', requirePermission('ops:console'), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const note = String(b?.note || '').slice(0, 500);
  const r = await transition(c, c.req.param('id'), ['pending_review', 'processing'], 'rejected', { review_note: note || null });
  if ('err' in r) return c.json({ error: r.err, status: (r as any).status }, r.code as any);
  await audit(c, 'withdrawal.reject', { id: c.req.param('id'), by: currentUser(c)?.id });
  await notifyOwner(c, r, 'Retiro rechazado', `Tu retiro de $${r.amount.toFixed(2)} ${r.currency || ''} fue rechazado.${note ? ' Motivo: ' + note : ' Revisa los detalles en Retiros.'}`);
  return c.json({ ok: true, status: 'rejected' });
});

// PATCH /:id/mark-completed — processing → completed (records the provider ref).
adminWithdrawals.patch('/:id/mark-completed', requirePermission('ops:console'), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = await transition(c, c.req.param('id'), ['processing'], 'completed', { provider_reference: String(b?.provider_reference || '').slice(0, 120) || null });
  if ('err' in r) return c.json({ error: r.err, status: (r as any).status }, r.code as any);
  await audit(c, 'withdrawal.complete', { id: c.req.param('id'), by: currentUser(c)?.id });
  await notifyOwner(c, r, 'Retiro completado', `Tu retiro de $${r.amount.toFixed(2)} ${r.currency || ''} fue enviado a tu destino. ✓`);
  return c.json({ ok: true, status: 'completed' });
});
