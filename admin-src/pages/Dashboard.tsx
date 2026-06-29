import { useState, useEffect } from 'preact/hooks';
import { rbac } from '../api';
import { useResource } from '../hooks';
import { PageHeader, StatTileSkeleton, Avatar, EmptyState } from '../components/ui';
import { ForbiddenInline, ErrorInline } from '../components/StateScreens';
import { Icon } from '../icons';
import { relTime } from '../util';
import { navigate } from '../router';

function Tile({ label, value, accent, hint }: { label: string; value: number | string; accent?: string; hint?: string }) {
  return (
    <div class="card p-4 transition-shadow hover:shadow-card">
      <div class="label-caps">{label}</div>
      <div class="flex items-end gap-2 mt-2">
        <span class="text-[28px] leading-none font-semibold tracking-[-0.02em]">{value}</span>
        {hint && <span class={`text-[12px] font-medium mb-1 ${accent || 'text-faint'}`}>{hint}</span>}
      </div>
    </div>
  );
}

// Discoverable, permission-gated entry to the CSP violation review page (/admin-csp).
// Self-gates by probing the security:read-protected endpoint with a RAW fetch (not the
// rbac api wrapper, so a 403 here never trips the global 401 sign-in handler): the card
// renders ONLY when the caller actually has access — invisible to everyone else.
function CspReviewCard() {
  const [s, setS] = useState<{ shown: boolean; distinct: number; hits: number }>({ shown: false, distinct: 0, hits: 0 });
  useEffect(() => {
    let alive = true;
    fetch('/api/rbac/csp-violations?limit=1', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((j) => { if (alive && j) setS({ shown: true, distinct: j.totals?.distinct_violations ?? 0, hits: j.totals?.total_hits ?? 0 }); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!s.shown) return null;
  const clean = s.distinct === 0;
  return (
    <a href="/admin-csp" class="card p-4 mb-7 flex items-center gap-4 transition-shadow hover:shadow-card" style={{ textDecoration: 'none' }}>
      <span class="w-10 h-10 rounded-lg surface-subtle bordered flex items-center justify-center text-faint shrink-0"><Icon.shield size={20} /></span>
      <div class="min-w-0 flex-1">
        <div class="text-[14px] font-semibold">Revisión de Seguridad — CSP <span class="text-faint font-normal">(Report-Only)</span></div>
        <div class="text-[12px] text-faint">
          {clean
            ? '✓ Sin violaciones registradas — listo para hacer cumplir la CSP estricta.'
            : `${s.distinct} violaciones distintas · ${s.hits} hits — revisar antes de hacer cumplir.`}
        </div>
      </div>
      <span class={`text-[12px] font-semibold shrink-0 ${clean ? 'text-ok' : 'text-warn'}`}>{clean ? 'Limpio →' : 'Revisar →'}</span>
    </a>
  );
}

export function DashboardPage() {
  const r = useResource(() => rbac.dashboard(), []);

  if (r.forbidden) return <Shell><ForbiddenInline /></Shell>;
  if (r.error) return <Shell><ErrorInline message={r.error} onRetry={r.reload} /></Shell>;

  const d = r.data;
  const u = d?.users;

  return (
    <Shell>
      <CspReviewCard />
      <section class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3.5 mb-7">
        {r.loading || !u ? (
          Array.from({ length: 6 }).map((_, i) => <StatTileSkeleton key={i} />)
        ) : (
          <>
            <Tile label="Usuarios" value={u.total} />
            <Tile label="Activos" value={u.active} accent="text-ok" />
            <Tile label="Suspendidos" value={u.suspended} accent="text-danger" />
            <Tile label="Pendientes" value={u.pending} accent="text-warn" />
            <Tile label="En línea" value={u.online} accent="text-ok" hint="●" />
            <Tile label="Accesos fallidos 24h" value={d!.failedLogins24h} accent="text-danger" />
          </>
        )}
      </section>

      <div class="grid lg:grid-cols-2 gap-5">
        <Panel title="Accesos recientes" icon="login" onAll={() => navigate('login-history')}>
          {r.loading ? <ListSkeleton /> : (d?.recentLogins?.length ? (
            <ul class="divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
              {d.recentLogins.slice(0, 8).map((e: any, i) => (
                <li key={i} class="flex items-center gap-3 py-2.5 px-1">
                  <Avatar email={e.email || e.user_email} name={e.name} size={30} />
                  <div class="min-w-0 flex-1">
                    <div class="text-[13px] font-medium truncate">{e.email || e.user_email || e.name || 'Usuario'}</div>
                    <div class="text-[12px] text-faint truncate">{e.ip || e.ip_address || e.user_agent || '—'}</div>
                  </div>
                  <span class="text-[12px] text-faint shrink-0">{relTime(e.ts || e.created_ms || e.at_ms)}</span>
                </li>
              ))}
            </ul>
          ) : <EmptyState title="Sin accesos recientes" icon="login" />)}
        </Panel>

        <Panel title="Cambios de permisos" icon="permissions" onAll={() => navigate('audit')}>
          {r.loading ? <ListSkeleton /> : (d?.permChanges?.length ? (
            <ul class="divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
              {d.permChanges.slice(0, 8).map((e: any, i) => (
                <li key={i} class="flex items-center gap-3 py-2.5 px-1">
                  <span class="w-7 h-7 rounded-md surface-subtle bordered flex items-center justify-center text-faint shrink-0"><Icon.permissions size={14} /></span>
                  <div class="min-w-0 flex-1">
                    <div class="text-[13px] font-medium truncate">{e.action || e.event || e.perm_key || 'Cambio'}</div>
                    <div class="text-[12px] text-faint truncate">{e.target || e.actor || e.detail || '—'}</div>
                  </div>
                  <span class="text-[12px] text-faint shrink-0">{relTime(e.ts || e.created_ms || e.at_ms)}</span>
                </li>
              ))}
            </ul>
          ) : <EmptyState title="Sin cambios registrados" icon="permissions" />)}
        </Panel>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: any }) {
  return (
    <div class="animate-fade-in">
      <PageHeader title="Dashboard" subtitle="Resumen de identidad y accesos" />
      {children}
    </div>
  );
}

function Panel({ title, icon, onAll, children }: { title: string; icon: keyof typeof Icon; onAll?: () => void; children: any }) {
  const I = Icon[icon];
  return (
    <div class="card p-4">
      <div class="flex items-center justify-between mb-1">
        <h2 class="text-[14px] font-semibold flex items-center gap-2"><span class="text-faint"><I size={16} /></span>{title}</h2>
        {onAll && <button class="btn btn-ghost btn-sm" onClick={onAll}>Ver todo</button>}
      </div>
      {children}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div class="py-1">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} class="flex items-center gap-3 py-2.5 px-1">
          <div class="skeleton w-7 h-7 rounded-full" />
          <div class="flex-1"><div class="skeleton h-3 w-1/2 mb-1.5" /><div class="skeleton h-2.5 w-1/3" /></div>
          <div class="skeleton h-2.5 w-10" />
        </div>
      ))}
    </div>
  );
}
