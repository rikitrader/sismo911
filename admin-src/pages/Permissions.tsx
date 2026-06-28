import { useState, useMemo } from 'preact/hooks';
import { rbac } from '../api';
import type { Permission } from '../api';
import { useResource } from '../hooks';
import { PageHeader, EmptyState } from '../components/ui';
import { ForbiddenInline, ErrorInline } from '../components/StateScreens';
import { Icon } from '../icons';

export function PermissionsPage() {
  const r = useResource(() => rbac.permissions(), []);
  const [q, setQ] = useState('');

  const categories = r.data?.categories || {};
  const total = useMemo(() => Object.values(categories).reduce((a, b) => a + b.length, 0), [categories]);

  const filtered = useMemo(() => {
    if (!q.trim()) return categories;
    const n = q.toLowerCase();
    const out: Record<string, Permission[]> = {};
    for (const [cat, list] of Object.entries(categories)) {
      const m = list.filter((p) => p.label.toLowerCase().includes(n) || p.key.toLowerCase().includes(n) || cat.toLowerCase().includes(n));
      if (m.length) out[cat] = m;
    }
    return out;
  }, [categories, q]);

  return (
    <div class="animate-fade-in">
      <PageHeader title="Permisos" subtitle={`Catálogo de solo lectura · ${total} permisos`} />
      {r.forbidden ? <ForbiddenInline /> : r.error ? <ErrorInline message={r.error} onRetry={r.reload} /> : (
        <>
          <div class="relative max-w-sm mb-5">
            <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"><Icon.search size={15} /></span>
            <input class="input pl-8" placeholder="Buscar permisos…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Buscar permisos" />
          </div>
          {r.loading ? (
            <div class="grid md:grid-cols-2 gap-4">{Array.from({ length: 4 }).map((_, i) => <div key={i} class="card p-4"><div class="skeleton h-4 w-24 mb-3" />{Array.from({ length: 3 }).map((_, j) => <div key={j} class="skeleton h-3.5 my-2" />)}</div>)}</div>
          ) : Object.keys(filtered).length === 0 ? (
            <EmptyState title={q ? 'Sin coincidencias' : 'Sin permisos'} hint={q ? `No hay permisos para “${q}”.` : 'El catálogo de permisos está vacío.'} icon="permissions" />
          ) : (
            <div class="grid md:grid-cols-2 gap-4">
              {Object.entries(filtered).map(([cat, list]) => (
                <section key={cat} class="card overflow-hidden">
                  <div class="flex items-center justify-between px-4 py-2.5 border-b surface-subtle">
                    <h2 class="text-[13px] font-semibold flex items-center gap-2"><Icon.permissions size={15} class="text-faint" />{cat}</h2>
                    <span class="pill surface bordered text-faint">{list.length}</span>
                  </div>
                  <ul class="divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
                    {list.map((p) => (
                      <li key={p.key} class="flex items-center gap-3 px-4 py-2.5">
                        <div class="min-w-0 flex-1"><div class="text-[13px] font-medium truncate">{p.label}</div><div class="text-[11px] text-faint font-mono truncate">{p.key}</div></div>
                        <div class="flex items-center gap-1.5 shrink-0">
                          <span class="pill surface-subtle bordered text-faint">{p.resource}</span>
                          <span class="pill bg-brand-500/10 text-[rgb(var(--accent))]">{p.action}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
