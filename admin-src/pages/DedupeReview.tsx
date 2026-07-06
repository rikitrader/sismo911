import { useState } from 'preact/hooks';
import { ApiError } from '../api';
import { useResource } from '../hooks';
import { PageHeader, Spinner, EmptyState } from '../components/ui';
import { ForbiddenInline, ErrorInline } from '../components/StateScreens';
import { Icon } from '../icons';
import { relTime } from '../util';
import { toast } from '../toast';

// Operator review of the dedupe pipeline's uncertain pairs + critical conflicts.
// The engine auto-merges only corroborated ≥90 matches; everything 70-89 (and
// every alive-vs-deceased contradiction) waits HERE for a human. Merge = the
// canonical restorable merge (personas_merge_log); reject = distinct people.

const BASE = '/api/admin/dedupe';
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      credentials: 'include',
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers || {}) },
      ...init,
    });
  } catch {
    throw new ApiError(0, 'No se pudo conectar con el servidor.');
  }
  const text = await res.text();
  let data: any = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent('rbac-unauthorized'));
    throw new ApiError(res.status, (data && (data.error || data.message)) || res.statusText, data);
  }
  return data as T;
}

interface Persona {
  id: string; nombre: string | null; edad: number | null; contacto: string | null;
  ubicacion: string | null; origen: string | null; ext_id: string | null; estado: string | null;
  fallecido: number; hospitalizado: number; foto_r2: string | null; merged_into: string | null; updated_at: number | null;
}
interface Candidate {
  id: string; id_a: string; id_b: string; score: number; signals: string[]; created_ms: number;
  a: Persona | null; b: Persona | null;
}
interface Conflict {
  id: string; candidate_id: string; field: string; value_a: string; value_b: string; severity: string;
  created_ms: number; a: Persona | null; b: Persona | null; score: number | null;
}
interface Stats { review: number; merged: number; rejected: number; conflicts: number; critical: number }

function estadoLabel(p: Persona): string {
  if (p.fallecido) return 'fallecido';
  if (p.hospitalizado) return 'hospitalizado';
  return p.estado || '—';
}

function PersonaCard({ p, side }: { p: Persona | null; side: string }) {
  if (!p) return <div class="rounded border border-slate-700 p-3 text-sm text-slate-400">({side}) registro no disponible</div>;
  const dead = !!p.fallecido;
  return (
    <div class="flex-1 rounded border border-slate-700 bg-slate-900/60 p-3 text-sm">
      <div class="mb-1 flex items-center gap-2">
        {p.foto_r2 ? (
          <img src={`/api/familia/photo/${encodeURIComponent(p.id)}`} alt="" class="h-10 w-10 rounded object-cover" loading="lazy" />
        ) : (
          <div class="flex h-10 w-10 items-center justify-center rounded bg-slate-800 text-slate-500"><Icon name="user" /></div>
        )}
        <div>
          <div class="font-semibold text-slate-100">{p.nombre || '(sin nombre)'}</div>
          <div class="text-xs text-slate-400">{p.id}</div>
        </div>
      </div>
      <dl class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-slate-300">
        <dt class="text-slate-500">Edad</dt><dd>{p.edad ?? '—'}</dd>
        <dt class="text-slate-500">Estado</dt><dd class={dead ? 'font-semibold text-red-400' : ''}>{estadoLabel(p)}</dd>
        <dt class="text-slate-500">Ubicación</dt><dd class="truncate" title={p.ubicacion || ''}>{p.ubicacion || '—'}</dd>
        <dt class="text-slate-500">Contacto</dt><dd class="truncate">{p.contacto || '—'}</dd>
        <dt class="text-slate-500">Origen</dt><dd class="truncate" title={p.ext_id || ''}>{p.origen || '—'}</dd>
        <dt class="text-slate-500">Act.</dt><dd>{p.updated_at ? relTime(p.updated_at) : '—'}</dd>
      </dl>
    </div>
  );
}

export function DedupeReviewPage() {
  const [tab, setTab] = useState<'pares' | 'conflictos'>('pares');
  const [busy, setBusy] = useState<string | null>(null);
  const stats = useResource<Stats>(() => api<Stats>('/stats'), []);
  const cands = useResource<{ total: number; nextCursor: number | null; candidates: Candidate[] }>(
    () => api('/candidates?decision=review&limit=25'),
    [],
  );
  const conflicts = useResource<{ conflicts: Conflict[] }>(() => api('/conflicts'), []);
  const [extra, setExtra] = useState<Candidate[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      toast(`✓ ${label}`);
      cands.reload(); stats.reload(); conflicts.reload(); setExtra([]); setCursor(null);
    } catch (e) {
      toast(e instanceof ApiError ? `Error: ${e.message}` : 'Error inesperado');
    } finally {
      setBusy(null);
    }
  };

  const loadMore = async () => {
    const cur = cursor ?? cands.data?.nextCursor;
    if (!cur) return;
    const page = await api<{ nextCursor: number | null; candidates: Candidate[] }>(`/candidates?decision=review&limit=25&cursor=${cur}`);
    setExtra((x) => [...x, ...page.candidates]);
    setCursor(page.nextCursor);
  };

  if (cands.forbidden) return <ForbiddenInline />;

  const s = stats.data;
  const list = [...(cands.data?.candidates ?? []), ...extra];

  return (
    <div>
      <PageHeader
        title="Duplicados"
        desc="Cola de revisión del motor de deduplicación: pares inciertos (70–89 pts) y conflictos críticos. Fusionar es reversible (personas_merge_log)."
      />
      <div class="mb-4 flex flex-wrap gap-2 text-xs">
        <span class="rounded bg-slate-800 px-2 py-1">En cola: <b>{s?.review ?? '…'}</b></span>
        <span class="rounded bg-slate-800 px-2 py-1">Fusionados: <b>{s?.merged ?? '…'}</b></span>
        <span class="rounded bg-slate-800 px-2 py-1">Rechazados: <b>{s?.rejected ?? '…'}</b></span>
        <span class={`rounded px-2 py-1 ${s?.critical ? 'bg-red-900/60 text-red-200' : 'bg-slate-800'}`}>Conflictos críticos: <b>{s?.critical ?? '…'}</b></span>
      </div>
      <div class="mb-4 flex gap-2">
        <button class={`rounded px-3 py-1.5 text-sm ${tab === 'pares' ? 'bg-lime-400 text-black' : 'bg-slate-800 text-slate-200'}`} onClick={() => setTab('pares')}>
          Pares ({s?.review ?? '…'})
        </button>
        <button class={`rounded px-3 py-1.5 text-sm ${tab === 'conflictos' ? 'bg-lime-400 text-black' : 'bg-slate-800 text-slate-200'}`} onClick={() => setTab('conflictos')}>
          Conflictos ({s?.conflicts ?? '…'})
        </button>
      </div>

      {tab === 'pares' && (
        <div class="space-y-4">
          {cands.loading && !cands.data && <Spinner />}
          {cands.error && <ErrorInline error={cands.error} retry={cands.reload} />}
          {cands.data && list.length === 0 && <EmptyState icon="check" title="Cola vacía" desc="No hay pares pendientes de revisión." />}
          {list.map((cd) => (
            <div key={cd.id} class="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
              <div class="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span class="rounded bg-slate-800 px-2 py-0.5 font-semibold text-slate-200">{cd.score} pts</span>
                {cd.signals.map((sg) => (
                  <span key={sg} class="rounded bg-slate-800/70 px-2 py-0.5">{sg}</span>
                ))}
                <span class="ml-auto">{relTime(cd.created_ms)}</span>
              </div>
              <div class="flex flex-col gap-3 sm:flex-row">
                <PersonaCard p={cd.a} side="A" />
                <PersonaCard p={cd.b} side="B" />
              </div>
              <div class="mt-3 flex flex-wrap gap-2">
                <button
                  class="rounded bg-lime-400 px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-50"
                  disabled={busy !== null || !!cd.a?.merged_into}
                  onClick={() => act(`Fusionado en ${cd.a?.nombre ?? cd.id_a}`, () => api(`/candidates/${cd.id}/merge`, { method: 'POST', body: JSON.stringify({ keeper: cd.id_a }) }))}
                >
                  ← Conservar A
                </button>
                <button
                  class="rounded bg-lime-400 px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-50"
                  disabled={busy !== null || !!cd.b?.merged_into}
                  onClick={() => act(`Fusionado en ${cd.b?.nombre ?? cd.id_b}`, () => api(`/candidates/${cd.id}/merge`, { method: 'POST', body: JSON.stringify({ keeper: cd.id_b }) }))}
                >
                  Conservar B →
                </button>
                <button
                  class="rounded border border-slate-600 px-3 py-1.5 text-sm text-slate-200 disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => act('Rechazado (personas distintas)', () => api(`/candidates/${cd.id}/reject`, { method: 'POST' }))}
                >
                  Personas distintas
                </button>
              </div>
            </div>
          ))}
          {(cursor ?? cands.data?.nextCursor) && (
            <button class="w-full rounded border border-slate-700 py-2 text-sm text-slate-300" onClick={loadMore}>
              Cargar más
            </button>
          )}
        </div>
      )}

      {tab === 'conflictos' && (
        <div class="space-y-4">
          {conflicts.loading && !conflicts.data && <Spinner />}
          {conflicts.error && <ErrorInline error={conflicts.error} retry={conflicts.reload} />}
          {conflicts.data && conflicts.data.conflicts.length === 0 && <EmptyState icon="check" title="Sin conflictos abiertos" desc="Todos los conflictos han sido revisados." />}
          {conflicts.data?.conflicts.map((cf) => (
            <div key={cf.id} class={`rounded-lg border p-3 ${cf.severity === 'critical' ? 'border-red-800 bg-red-950/30' : 'border-slate-700 bg-slate-900/40'}`}>
              <div class="mb-2 flex items-center gap-2 text-xs">
                <span class={`rounded px-2 py-0.5 font-semibold ${cf.severity === 'critical' ? 'bg-red-900 text-red-100' : 'bg-slate-800 text-slate-200'}`}>
                  {cf.severity === 'critical' ? 'CRÍTICO' : 'revisar'} · {cf.field}
                </span>
                <span class="text-slate-300">“{cf.value_a}” vs “{cf.value_b}”</span>
                <span class="ml-auto text-slate-500">{relTime(cf.created_ms)}</span>
              </div>
              <div class="flex flex-col gap-3 sm:flex-row">
                <PersonaCard p={cf.a} side="A" />
                <PersonaCard p={cf.b} side="B" />
              </div>
              <div class="mt-3">
                <button
                  class="rounded border border-slate-600 px-3 py-1.5 text-sm text-slate-200 disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => act('Conflicto marcado como revisado', () => api(`/conflicts/${cf.id}/resolve`, { method: 'POST' }))}
                >
                  Marcar revisado
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
