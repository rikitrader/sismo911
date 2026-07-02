import { rbac } from '../api';
import type { EvaluacionRow } from '../api';
import { useResource } from '../hooks';
import { PageHeader, EmptyState, Spinner } from '../components/ui';
import { ForbiddenInline, ErrorInline } from '../components/StateScreens';
import { Icon } from '../icons';
import { relTime, fullTime } from '../util';

// Eng N1/2/3 structural-evaluation overview (ATC-20-inspired pipeline).
// Read-only: one row per building with signed eval-tracking events; event entry
// happens on the public dossier (/edificio/:id → Evaluación tab), linked per row.
const ST_LABEL: Record<string, string> = { pendiente: 'Pendiente', en_curso: 'En curso', completada: 'Completada', bloqueada: 'Bloqueada' };
const ST_CLASS: Record<string, string> = {
  pendiente: 'bg-slate-500/15 text-slate-400',
  en_curso: 'bg-amber-500/15 text-amber-400',
  completada: 'bg-emerald-500/15 text-emerald-400',
  bloqueada: 'bg-red-500/15 text-red-400',
};

function LevelChip({ level, status }: { level: number; status: string }) {
  return (
    <span class={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-bold ${ST_CLASS[status] || ST_CLASS.pendiente}`} title={`Nivel ${level}: ${ST_LABEL[status] || status}`}>
      N{level} · {ST_LABEL[status] || status}
    </span>
  );
}

export function EvaluacionesPage() {
  const r = useResource(() => rbac.evaluaciones(), []);
  const rows: EvaluacionRow[] = r.data?.evaluaciones || [];
  return (
    <div class="animate-fade-in">
      <PageHeader
        title="Evaluaciones"
        subtitle="Seguimiento de evaluación estructural por edificio — Eng Nivel 1/2/3 (ATC-20), eventos firmados SHA-256"
        actions={<button class="btn btn-ghost btn-sm" onClick={r.reload} aria-label="Recargar">{r.loading ? <Spinner /> : <Icon.refresh size={15} />}</button>}
      />
      {r.forbidden ? <ForbiddenInline /> : r.error ? <ErrorInline message={r.error} onRetry={r.reload} /> : (
        <div class="card p-4">
          {r.loading && !rows.length ? <div class="py-8 text-center"><Spinner /></div> : !rows.length ? (
            <EmptyState
              title="Sin evaluaciones registradas"
              subtitle="Ningún edificio tiene eventos de seguimiento todavía. Los operadores los registran en el expediente público (/edificio/:id → Evaluación)."
            />
          ) : (
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-left text-[10.5px] uppercase tracking-wide text-[var(--muted)]">
                    <th class="py-2 pr-3">Edificio</th>
                    <th class="py-2 pr-3">Pipeline N1 / N2 / N3</th>
                    <th class="py-2 pr-3">Progreso</th>
                    <th class="py-2 pr-3">Eventos</th>
                    <th class="py-2 pr-3">Última actividad</th>
                    <th class="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.building_id} class="border-t border-[var(--line)]">
                      <td class="py-2.5 pr-3 font-semibold">{e.name}</td>
                      <td class="py-2.5 pr-3">
                        <div class="flex flex-wrap gap-1">
                          {[1, 2, 3].map((l) => <LevelChip level={l} status={e.levels[String(l)] || 'pendiente'} />)}
                        </div>
                      </td>
                      <td class="py-2.5 pr-3 tabular-nums">{e.progress}%</td>
                      <td class="py-2.5 pr-3 tabular-nums">{e.events}</td>
                      <td class="py-2.5 pr-3 text-[var(--muted)]" title={e.lastAt ? fullTime(e.lastAt) : ''}>
                        {e.lastAt ? relTime(e.lastAt) : '—'}{e.lastBy ? ` · ✍ ${e.lastBy}` : ''}
                      </td>
                      <td class="py-2.5 text-right">
                        <a class="btn btn-ghost btn-sm" href={`/edificio/${encodeURIComponent(e.building_id)}`} target="_blank" rel="noopener">Expediente →</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
