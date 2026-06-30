import { useState } from 'preact/hooks';
import { ApiError } from '../api';
import { useResource } from '../hooks';
import { PageHeader, Spinner, EmptyState } from '../components/ui';
import { ForbiddenInline, ErrorInline } from '../components/StateScreens';
import { Icon } from '../icons';
import { relTime } from '../util';
import { toast } from '../toast';

// Suministros citizen review (operator-facing). Two views:
//   • "Solicitudes de acceso" — enrollment applications (aprobar / rechazar).
//   • "Pedidos de insumos"     — supply requests moved through their lifecycle
//     (pendiente → aprobada → en_camino → entregada / rechazada).
// Cookie-authed; every endpoint is gated by ops:console on the server.
// Self-contained fetch helper (the shared api.ts is scoped to /api/rbac).

const BASE = '/api/suministros-ciudadano';
async function sc<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      credentials: 'include',
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers || {}) },
      ...init,
    });
  } catch { throw new ApiError(0, 'No se pudo conectar con el servidor.'); }
  const text = await res.text();
  let data: any = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent('rbac-unauthorized'));
    throw new ApiError(res.status, (data && (data.error || data.message)) || res.statusText, data);
  }
  return data as T;
}

interface Enrollment {
  id: string; user_id: string; nombre: string; cedula: string; contacto: string; ubicacion: string;
  tipo: string; personas: number; necesidad: string; status: string;
  review_note: string | null; reviewer: string | null; created_ms: number; reviewed_ms: number | null;
}
interface Pedido {
  id: string; user_id: string; nombre: string | null; tipo: string; cantidad: number;
  urgencia: string; descripcion: string; status: string; note: string | null;
  created_ms: number; updated_ms: number;
}

const TIPO_LABEL: Record<string, string> = {
  beneficiario: 'Beneficiario', coordinador_refugio: 'Coordinador de refugio',
  lider_comunitario: 'Líder comunitario', organizacion: 'Organización',
};
const PEDIDO_TIPO_LABEL: Record<string, string> = {
  alimentos: 'Alimentos', agua: 'Agua', medicinas: 'Medicinas',
  higiene: 'Higiene', abrigo: 'Abrigo', otro: 'Otro',
};
const ENR_STATUS_LABEL: Record<string, string> = { pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada' };
const PED_STATUS_LABEL: Record<string, string> = { pendiente: 'Pendiente', aprobada: 'Aprobada', en_camino: 'En camino', entregada: 'Entregada', rechazada: 'Rechazada' };
const STATUS_CLS: Record<string, string> = { pendiente: 'text-warn', aprobada: 'text-brand', en_camino: 'text-brand', entregada: 'text-ok', rechazada: 'text-danger' };

const ENR_FILTERS = [
  { id: 'pendiente', label: 'Pendientes' }, { id: 'aprobada', label: 'Aprobadas' },
  { id: 'rechazada', label: 'Rechazadas' }, { id: '', label: 'Todas' },
];
const PED_FILTERS = [
  { id: 'pendiente', label: 'Pendientes' }, { id: 'aprobada', label: 'Aprobadas' },
  { id: 'en_camino', label: 'En camino' }, { id: 'entregada', label: 'Entregadas' },
  { id: 'rechazada', label: 'Rechazadas' }, { id: '', label: 'Todos' },
];
// Available status transitions for a pedido, by current status.
const NEXT_ACTIONS: Record<string, { status: string; label: string; reject?: boolean }[]> = {
  pendiente: [{ status: 'aprobada', label: 'Aprobar' }, { status: 'rechazada', label: 'Rechazar', reject: true }],
  aprobada: [{ status: 'en_camino', label: 'En camino' }, { status: 'rechazada', label: 'Rechazar', reject: true }],
  en_camino: [{ status: 'entregada', label: 'Marcar entregada' }],
  entregada: [],
  rechazada: [],
};

export function SumSolicitudesPage() {
  const [view, setView] = useState<'acceso' | 'pedidos'>('acceso');
  return (
    <div class="animate-fade-in">
      <PageHeader
        title="Suministros · ciudadanos"
        subtitle="Solicitudes de acceso y pedidos de insumos de los ciudadanos"
      />
      <div class="flex flex-wrap items-center gap-2 mb-4">
        <button class={`pill ${view === 'acceso' ? 'bg-brand text-white' : 'surface-subtle bordered text-muted'}`} onClick={() => setView('acceso')}>Solicitudes de acceso</button>
        <button class={`pill ${view === 'pedidos' ? 'bg-brand text-white' : 'surface-subtle bordered text-muted'}`} onClick={() => setView('pedidos')}>Pedidos de insumos</button>
      </div>
      {view === 'acceso' ? <AccesoView /> : <PedidosView />}
    </div>
  );
}

function AccesoView() {
  const [filter, setFilter] = useState('pendiente');
  const [busyId, setBusyId] = useState<string | null>(null);
  const list = useResource<{ solicitudes: Enrollment[] }>(
    () => sc(`/admin/solicitudes${filter ? `?status=${encodeURIComponent(filter)}` : ''}`),
    [filter],
  );
  const items = list.data?.solicitudes || [];
  if (list.forbidden) return <ForbiddenInline message="Necesitas el permiso ops:console para revisar las solicitudes." />;
  if (list.unauthorized) return <ErrorInline message="Tu sesión expiró. Vuelve a iniciar sesión." />;

  async function review(id: string, action: 'aprobar' | 'rechazar') {
    let note = '';
    if (action === 'rechazar') { const n = prompt('Motivo del rechazo (opcional):'); if (n === null) return; note = n.trim(); }
    setBusyId(id);
    try {
      await sc(`/admin/solicitudes/${id}/${action}`, { method: 'POST', body: JSON.stringify({ note }) });
      toast(action === 'aprobar' ? 'Solicitud aprobada.' : 'Solicitud rechazada.', 'success');
      list.reload();
    } catch (e: any) { toast(e?.message || 'No se pudo actualizar.', 'error'); }
    finally { setBusyId(null); }
  }

  return (
    <>
      <Filters filters={ENR_FILTERS} value={filter} onChange={setFilter} onReload={list.reload} />
      {list.loading ? <div class="card p-6 flex justify-center"><Spinner /></div>
        : !items.length ? <EmptyState icon="inbox" title="Sin solicitudes" hint="No hay solicitudes para este filtro." />
        : (
          <div class="grid gap-3">
            {items.map((e) => (
              <div key={e.id} class="card">
                <div class="flex items-start justify-between gap-3 flex-wrap">
                  <div class="min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="font-semibold text-[15px] truncate">{e.nombre || 'Sin nombre'}</span>
                      <span class={`text-[11px] font-semibold uppercase tracking-wide ${STATUS_CLS[e.status] || ''}`}>{ENR_STATUS_LABEL[e.status] || e.status}</span>
                    </div>
                    <div class="text-[12px] text-faint mt-0.5">
                      {TIPO_LABEL[e.tipo] || e.tipo}{e.cedula ? ` · CI ${e.cedula}` : ''}{e.contacto ? ` · ${e.contacto}` : ''}{` · ${relTime(e.created_ms)}`}
                    </div>
                  </div>
                  {e.status === 'pendiente' && (
                    <div class="flex gap-2 shrink-0">
                      <button class="btn btn-primary btn-sm" disabled={busyId === e.id} onClick={() => review(e.id, 'aprobar')}><Icon.check size={14} /> Aprobar</button>
                      <button class="btn btn-outline btn-sm text-danger" disabled={busyId === e.id} onClick={() => review(e.id, 'rechazar')}><Icon.ban size={14} /> Rechazar</button>
                    </div>
                  )}
                </div>
                <div class="grid gap-1.5 mt-3 text-[13px]">
                  {e.ubicacion && <div><span class="text-faint">Ubicación:</span> {e.ubicacion}</div>}
                  <div><span class="text-faint">Personas a cargo:</span> {e.personas}</div>
                  {e.necesidad && <div><span class="text-faint">Necesidad:</span> <span class="whitespace-pre-wrap break-words">{e.necesidad}</span></div>}
                  {e.review_note && <div><span class="text-faint">Nota del revisor:</span> {e.review_note}</div>}
                  {e.reviewer && e.status !== 'pendiente' && <div class="text-[12px] text-faint">Revisado por {e.reviewer}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
    </>
  );
}

function PedidosView() {
  const [filter, setFilter] = useState('pendiente');
  const [busyId, setBusyId] = useState<string | null>(null);
  const list = useResource<{ pedidos: Pedido[] }>(
    () => sc(`/admin/pedidos${filter ? `?status=${encodeURIComponent(filter)}` : ''}`),
    [filter],
  );
  const items = list.data?.pedidos || [];
  if (list.forbidden) return <ForbiddenInline message="Necesitas el permiso ops:console para gestionar los pedidos." />;
  if (list.unauthorized) return <ErrorInline message="Tu sesión expiró. Vuelve a iniciar sesión." />;

  async function setEstado(id: string, status: string, reject?: boolean) {
    let note = '';
    if (reject) { const n = prompt('Motivo del rechazo (opcional):'); if (n === null) return; note = n.trim(); }
    setBusyId(id);
    try {
      await sc(`/admin/pedidos/${id}/estado`, { method: 'POST', body: JSON.stringify({ status, note }) });
      toast(`Pedido marcado como "${PED_STATUS_LABEL[status] || status}".`, 'success');
      list.reload();
    } catch (e: any) { toast(e?.message || 'No se pudo actualizar.', 'error'); }
    finally { setBusyId(null); }
  }

  return (
    <>
      <Filters filters={PED_FILTERS} value={filter} onChange={setFilter} onReload={list.reload} />
      {list.loading ? <div class="card p-6 flex justify-center"><Spinner /></div>
        : !items.length ? <EmptyState icon="inbox" title="Sin pedidos" hint="No hay pedidos de insumos para este filtro." />
        : (
          <div class="grid gap-3">
            {items.map((p) => (
              <div key={p.id} class="card">
                <div class="flex items-start justify-between gap-3 flex-wrap">
                  <div class="min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="font-semibold text-[15px] truncate">{PEDIDO_TIPO_LABEL[p.tipo] || p.tipo} · {p.cantidad}</span>
                      <span class={`text-[11px] font-semibold uppercase tracking-wide ${STATUS_CLS[p.status] || ''}`}>{PED_STATUS_LABEL[p.status] || p.status}</span>
                    </div>
                    <div class="text-[12px] text-faint mt-0.5">
                      {p.nombre || 'Ciudadano'}{p.urgencia ? ` · urgencia ${p.urgencia}` : ''}{` · ${relTime(p.created_ms)}`}
                    </div>
                  </div>
                  {(NEXT_ACTIONS[p.status] || []).length > 0 && (
                    <div class="flex gap-2 shrink-0 flex-wrap">
                      {(NEXT_ACTIONS[p.status] || []).map((a) => (
                        <button key={a.status} class={`btn btn-sm ${a.reject ? 'btn-outline text-danger' : 'btn-primary'}`} disabled={busyId === p.id} onClick={() => setEstado(p.id, a.status, a.reject)}>
                          {a.reject ? <Icon.ban size={14} /> : <Icon.check size={14} />} {a.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {(p.descripcion || p.note) && (
                  <div class="grid gap-1.5 mt-3 text-[13px]">
                    {p.descripcion && <div><span class="text-faint">Detalle:</span> <span class="whitespace-pre-wrap break-words">{p.descripcion}</span></div>}
                    {p.note && <div><span class="text-faint">Nota del operador:</span> {p.note}</div>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
    </>
  );
}

function Filters({ filters, value, onChange, onReload }: { filters: { id: string; label: string }[]; value: string; onChange: (v: string) => void; onReload: () => void }) {
  return (
    <div class="flex flex-wrap items-center gap-2 mb-4">
      {filters.map((f) => (
        <button key={f.id} class={`pill ${value === f.id ? 'bg-brand text-white' : 'surface-subtle bordered text-muted'}`} onClick={() => onChange(f.id)}>{f.label}</button>
      ))}
      <button class="btn btn-ghost btn-sm ml-auto" onClick={onReload} aria-label="Recargar"><Icon.refresh size={15} /> Recargar</button>
    </div>
  );
}
