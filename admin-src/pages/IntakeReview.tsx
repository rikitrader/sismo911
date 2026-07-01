import { useState } from 'preact/hooks';
import { ApiError } from '../api';
import { useResource } from '../hooks';
import { PageHeader, Spinner, EmptyState } from '../components/ui';
import { ForbiddenInline, ErrorInline } from '../components/StateScreens';
import { Icon } from '../icons';
import { relTime } from '../util';
import { toast } from '../toast';

// Operator review of Telegram photo/PDF intake submissions. The bot files every
// submission into intake_submissions (+ a DRAFT persona / pending lead); nothing
// is public until an operator approves here. Cookie-authed; every endpoint is
// gated by ops:console on the server.

const BASE = '/api/admin/intake';
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
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent('rbac-unauthorized'));
    throw new ApiError(res.status, (data && (data.error || data.message)) || res.statusText, data);
  }
  return data as T;
}

interface Fields {
  nombre: string | null;
  cedula: string | null;
  edad: number | null;
  ubicacion: string | null;
  fecha: string | null;
  contacto: string | null;
  descripcion: string | null;
}
interface Submission {
  id: string;
  code: string;
  channel: string;
  from: string;
  mime: string | null;
  is_image: boolean;
  outcome: string;
  person_id: string | null;
  intel_id: string | null;
  match_score: number | null;
  note: string | null;
  fields: Fields;
  display_name: string | null;
  person_moderation: string | null;
  person_photo_url: string | null;
  intel_status?: string | null;
  created_ms: number;
}

const OUTCOME_LABEL: Record<string, string> = {
  matched: 'Coincide', created: 'Borrador nuevo', needs_review: 'Revisar', error: 'Error', approved: 'Aprobado', rejected: 'Rechazado',
};
const OUTCOME_CLS: Record<string, string> = {
  matched: 'text-info', created: 'text-warn', needs_review: 'text-warn', error: 'text-danger', approved: 'text-ok', rejected: 'text-faint',
};
const FILTERS: { id: string; label: string }[] = [
  { id: '', label: 'Pendientes' },
  { id: 'created', label: 'Borradores' },
  { id: 'needs_review', label: 'Sin datos' },
  { id: 'matched', label: 'Coincidencias' },
  { id: 'approved', label: 'Aprobados' },
  { id: 'rejected', label: 'Rechazados' },
];

export function IntakeReviewPage() {
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = useResource<{ submissions: Submission[] }>(() => api(`/${filter ? `?status=${filter}` : ''}`), [filter]);
  const subs = list.data?.submissions || [];

  if (list.forbidden) return <ForbiddenInline message="Necesitas el permiso ops:console para revisar el intake." />;
  if (list.unauthorized) return <ErrorInline message="Tu sesión expiró. Vuelve a iniciar sesión." />;

  return (
    <div class="animate-fade-in">
      <PageHeader
        title="Intake Telegram"
        subtitle="Fotos y PDF recibidos por el bot · aprueba, rechaza o vincula a un caso"
        actions={<button class="btn btn-ghost btn-sm" onClick={list.reload} aria-label="Recargar"><Icon.refresh size={15} /> Recargar</button>}
      />

      <div class="flex flex-wrap items-center gap-2 mb-4">
        {FILTERS.map((f) => (
          <button key={f.id} class={`pill ${filter === f.id ? 'bg-brand text-white' : 'surface-subtle bordered text-muted'}`} onClick={() => { setFilter(f.id); setSelectedId(null); }}>
            {f.label}
          </button>
        ))}
      </div>

      <div class="grid gap-4" style="grid-template-columns:minmax(280px,360px) 1fr">
        <div class="card p-0 overflow-hidden" style="max-height:72vh;overflow-y:auto">
          {list.loading ? (
            <div class="p-6 flex justify-center"><Spinner /></div>
          ) : !subs.length ? (
            <EmptyState icon="inbox" title="Sin envíos" hint="No hay envíos para este filtro." />
          ) : (
            subs.map((s) => (
              <button key={s.id} class={`w-full text-left px-4 py-3 border-b bordered hover:surface-subtle transition ${selectedId === s.id ? 'surface-subtle' : ''}`} onClick={() => setSelectedId(s.id)}>
                <div class="flex items-center gap-2">
                  <span class="pill surface-subtle bordered font-mono text-[11px] text-info">{s.code}</span>
                  <span class={`text-[11px] font-semibold uppercase tracking-wide ${OUTCOME_CLS[s.outcome] || ''}`}>{OUTCOME_LABEL[s.outcome] || s.outcome}</span>
                  {!s.is_image && <span class="ml-auto pill surface-subtle bordered text-[10px] text-faint">PDF</span>}
                </div>
                <div class="font-medium truncate mt-1">{s.display_name || '(sin nombre legible)'}</div>
                <div class="text-[12px] text-faint truncate">{s.from} · {relTime(s.created_ms)}</div>
              </button>
            ))
          )}
        </div>

        {selectedId ? (
          <SubmissionDetail key={selectedId} id={selectedId} onChanged={list.reload} />
        ) : (
          <div class="card flex items-center justify-center text-faint" style="min-height:280px">Selecciona un envío para revisarlo.</div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | number | null }) {
  if (value == null || value === '') return null;
  return (
    <div class="flex gap-2 text-[13px] py-0.5">
      <span class="text-faint w-24 shrink-0">{label}</span>
      <span class="break-words">{value}</span>
    </div>
  );
}

function SubmissionDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const r = useResource<{ submission: Submission }>(() => api(`/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  const [linkId, setLinkId] = useState('');
  const s = r.data?.submission;

  async function act(path: string, body?: unknown, ok = 'Listo.') {
    setBusy(true);
    try {
      await api(`/${id}/${path}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });
      toast(ok, 'success');
      r.reload();
      onChanged();
    } catch (e: any) {
      toast(e?.message || 'No se pudo completar.', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (r.loading) return <div class="card flex items-center justify-center" style="min-height:280px"><Spinner /></div>;
  if (r.forbidden) return <ForbiddenInline message="Necesitas el permiso ops:console." />;
  if (!s) return <ErrorInline message={r.error || 'No se pudo cargar el envío.'} />;

  const terminal = s.outcome === 'approved' || s.outcome === 'rejected';
  const f = s.fields;

  return (
    <div class="card flex flex-col" style="max-height:72vh;overflow-y:auto">
      <div class="flex items-start justify-between gap-3 pb-3 border-b bordered">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="pill surface-subtle bordered font-mono text-info">{s.code}</span>
            <span class={`text-[12px] font-semibold uppercase tracking-wide ${OUTCOME_CLS[s.outcome] || ''}`}>{OUTCOME_LABEL[s.outcome] || s.outcome}</span>
            {s.match_score != null && <span class="text-[12px] text-faint">{Math.round(s.match_score * 100)}%</span>}
          </div>
          <div class="font-semibold text-[15px] mt-1.5 truncate">{s.display_name || '(sin nombre legible)'}</div>
          <div class="text-[12px] text-faint truncate">{s.from} · {relTime(s.created_ms)} · {s.mime || '—'}</div>
        </div>
      </div>

      {/* Evidence */}
      <div class="py-3 border-b bordered">
        {s.is_image ? (
          <a href={`${BASE}/${id}/evidence`} target="_blank" rel="noopener">
            <img src={`${BASE}/${id}/evidence`} alt="Evidencia" class="rounded-lg bordered max-h-64 object-contain bg-black/5" />
          </a>
        ) : (
          <a class="btn btn-outline btn-sm" href={`${BASE}/${id}/evidence`} target="_blank" rel="noopener"><Icon.download size={14} /> Abrir PDF</a>
        )}
      </div>

      {/* Extracted fields */}
      <div class="py-3 border-b bordered">
        <div class="text-[12px] text-faint uppercase tracking-wide mb-1">Datos extraídos (Workers AI)</div>
        <Row label="Nombre" value={f.nombre} />
        <Row label="Cédula" value={f.cedula} />
        <Row label="Edad" value={f.edad} />
        <Row label="Ubicación" value={f.ubicacion} />
        <Row label="Fecha" value={f.fecha} />
        <Row label="Contacto" value={f.contacto} />
        <Row label="Descripción" value={f.descripcion} />
        {!f.nombre && !f.cedula && <div class="text-[13px] text-warn">No se leyó un nombre ni cédula. Vincúlalo manualmente a un caso o recházalo.</div>}
      </div>

      {/* Linked case */}
      {s.person_id && (
        <div class="py-3 border-b bordered text-[13px]">
          <span class="text-faint">Caso: </span>
          {s.person_photo_url && <a class="text-info underline" href={`/familia?caso=${s.person_id.replace(/^fam-/, '')}`} target="_blank" rel="noopener">{s.person_id}</a>}
          {!s.person_photo_url && <span class="font-mono">{s.person_id}</span>}
          {s.person_moderation && <span class="ml-2 pill surface-subtle bordered text-[11px]">{s.person_moderation}</span>}
          {s.intel_status && <span class="ml-1 pill surface-subtle bordered text-[11px]">lead: {s.intel_status}</span>}
        </div>
      )}

      {s.note && <div class="py-2 text-[12px] text-faint">{s.note}</div>}

      {/* Actions */}
      {terminal ? (
        <div class="pt-3 text-[13px] text-faint">Envío resuelto ({OUTCOME_LABEL[s.outcome]}). {s.note}</div>
      ) : (
        <div class="pt-3 flex flex-col gap-3">
          <div class="flex flex-wrap gap-2">
            <button class="btn btn-primary btn-sm" disabled={busy || (!s.person_id && !f.nombre)} onClick={() => act('approve', undefined, 'Aprobado y publicado.')}>
              <Icon.check size={14} /> Aprobar {s.outcome === 'created' ? '(publicar borrador)' : ''}
            </button>
            <button class="btn btn-outline btn-sm text-danger" disabled={busy} onClick={() => act('reject', undefined, 'Rechazado.')}>
              <Icon.ban size={14} /> Rechazar
            </button>
          </div>
          <div class="flex items-center gap-2">
            <input class="input flex-1" placeholder="Vincular a caso existente (fam-xxxxxxxx)" value={linkId} disabled={busy} onInput={(e) => setLinkId((e.target as HTMLInputElement).value)} />
            <button class="btn btn-outline btn-sm" disabled={busy || !linkId.trim()} onClick={() => act('link', { personId: linkId.trim() }, 'Vinculado al caso.')}>
              <Icon.link size={14} /> Vincular
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
