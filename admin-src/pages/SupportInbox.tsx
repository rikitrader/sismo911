import { useState, useCallback, useEffect } from 'preact/hooks';
import { ApiError } from '../api';
import { useResource } from '../hooks';
import { PageHeader, Spinner, EmptyState } from '../components/ui';
import { ForbiddenInline, ErrorInline } from '../components/StateScreens';
import { Icon } from '../icons';
import { relTime } from '../util';
import { toast } from '../toast';

// Support inbox (operator-facing) — the staff side of the citizen "Soporte"
// tickets. Cookie-authed; every endpoint is gated by ops:console on the server.
// Self-contained fetch helper (the shared api.ts is scoped to /api/rbac).

const BASE = '/api/support';
async function sup<T>(path: string, init?: RequestInit): Promise<T> {
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

interface Ticket {
  id: string; ref: string; subject: string; category: string; category_label: string;
  priority: string; status: string; assigned_to: string | null;
  msg_count: number; unread_user: number; unread_staff: number;
  last_message_ms: number | null; last_sender: string | null; created_ms: number; updated_ms: number;
  email: string | null; name: string | null; user_id: string | null;
}
interface Message { id: string; author_type: string; author_name: string | null; body: string; via: string; created_ms: number; }

const STATUS_LABEL: Record<string, string> = { open: 'Abierto', pending: 'Esperando ciudadano', answered: 'Respondido', resolved: 'Resuelto', closed: 'Cerrado' };
const STATUS_CLS: Record<string, string> = { open: 'text-info', pending: 'text-warn', answered: 'text-ok', resolved: 'text-ok', closed: 'text-faint' };
const PRIORITY_LABEL: Record<string, string> = { low: 'Baja', normal: 'Normal', high: 'Alta', urgent: 'Urgente' };
const FILTERS: { id: string; label: string }[] = [
  { id: '', label: 'Todos' }, { id: 'open', label: 'Abiertos' }, { id: 'pending', label: 'Pendientes' },
  { id: 'answered', label: 'Respondidos' }, { id: 'resolved', label: 'Resueltos' }, { id: 'closed', label: 'Cerrados' },
];

export function SupportInboxPage() {
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = useResource<{ tickets: Ticket[] }>(
    () => sup(`/admin/tickets?${new URLSearchParams({ ...(filter ? { status: filter } : {}), ...(q ? { q } : {}) })}`),
    [filter, q],
  );
  const tickets = list.data?.tickets || [];

  if (list.forbidden) return <ForbiddenInline message="Necesitas el permiso ops:console para el soporte." />;
  if (list.unauthorized) return <ErrorInline message="Tu sesión expiró. Vuelve a iniciar sesión." />;

  return (
    <div class="animate-fade-in">
      <PageHeader
        title="Soporte"
        subtitle="Tickets de los ciudadanos · responde y haz seguimiento"
        actions={<button class="btn btn-ghost btn-sm" onClick={list.reload} aria-label="Recargar"><Icon.refresh size={15} /> Recargar</button>}
      />

      <InboundEmailToggle />

      <div class="flex flex-wrap items-center gap-2 mb-4">
        {FILTERS.map((f) => (
          <button key={f.id} class={`pill ${filter === f.id ? 'bg-brand text-white' : 'surface-subtle bordered text-muted'}`} onClick={() => { setFilter(f.id); setSelectedId(null); }}>
            {f.label}
          </button>
        ))}
        <div class="relative ml-auto">
          <input class="input pl-8" placeholder="Buscar ref, asunto, correo…" value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)} style="min-width:220px" />
          <Icon.search size={14} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
        </div>
      </div>

      <div class="grid gap-4" style="grid-template-columns:minmax(280px,360px) 1fr">
        {/* Ticket list */}
        <div class="card p-0 overflow-hidden" style="max-height:72vh;overflow-y:auto">
          {list.loading ? <div class="p-6 flex justify-center"><Spinner /></div>
            : !tickets.length ? <EmptyState icon="inbox" title="Sin tickets" hint="No hay tickets para este filtro." />
            : tickets.map((t) => (
              <button key={t.id} class={`w-full text-left px-4 py-3 border-b bordered hover:surface-subtle transition ${selectedId === t.id ? 'surface-subtle' : ''}`}
                onClick={() => setSelectedId(t.id)}>
                <div class="flex items-center gap-2">
                  <span class="pill surface-subtle bordered font-mono text-[11px] text-info">{t.ref}</span>
                  <span class={`text-[11px] font-semibold uppercase tracking-wide ${STATUS_CLS[t.status] || ''}`}>{STATUS_LABEL[t.status] || t.status}</span>
                  {t.unread_staff > 0 && <span class="ml-auto pill bg-danger text-white text-[10px]">{t.unread_staff}</span>}
                </div>
                <div class="font-medium truncate mt-1">{t.subject}</div>
                <div class="text-[12px] text-faint truncate">{t.name || t.email || 'Ciudadano'} · {relTime(t.last_message_ms || t.created_ms)}</div>
              </button>
            ))}
        </div>

        {/* Detail */}
        {selectedId
          ? <TicketDetail key={selectedId} id={selectedId} onChanged={list.reload} />
          : <div class="card flex items-center justify-center text-faint" style="min-height:280px">Selecciona un ticket para verlo.</div>}
      </div>
    </div>
  );
}

function TicketDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const r = useResource<{ ticket: Ticket; messages: Message[] }>(() => sup(`/admin/tickets/${id}`), [id]);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  const t = r.data?.ticket;
  const messages = r.data?.messages || [];

  const refresh = useCallback(() => { r.reload(); onChanged(); }, [r, onChanged]);

  useEffect(() => { setReply(''); }, [id]);

  async function sendReply() {
    if (!reply.trim()) { toast('Escribe una respuesta.', 'error'); return; }
    setBusy(true);
    try { await sup(`/admin/tickets/${id}/reply`, { method: 'POST', body: JSON.stringify({ body: reply.trim() }) }); setReply(''); toast('Respuesta enviada al ciudadano.', 'success'); refresh(); }
    catch (e: any) { toast(e?.message || 'No se pudo enviar.', 'error'); }
    finally { setBusy(false); }
  }
  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    try { await sup(`/admin/tickets/${id}`, { method: 'PATCH', body: JSON.stringify(body) }); toast('Ticket actualizado.', 'success'); refresh(); }
    catch (e: any) { toast(e?.message || 'No se pudo actualizar.', 'error'); }
    finally { setBusy(false); }
  }

  if (r.loading) return <div class="card flex items-center justify-center" style="min-height:280px"><Spinner /></div>;
  if (r.forbidden) return <ForbiddenInline message="Necesitas el permiso ops:console para el soporte." />;
  if (!t) return <ErrorInline message={r.error || 'No se pudo cargar el ticket.'} />;

  return (
    <div class="card flex flex-col" style="max-height:72vh">
      <div class="flex items-start justify-between gap-3 pb-3 border-b bordered">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="pill surface-subtle bordered font-mono text-info">{t.ref}</span>
            <span class={`text-[12px] font-semibold uppercase tracking-wide ${STATUS_CLS[t.status] || ''}`}>{STATUS_LABEL[t.status] || t.status}</span>
          </div>
          <div class="font-semibold text-[15px] mt-1.5 truncate">{t.subject}</div>
          <div class="text-[12px] text-faint truncate">{t.category_label} · {t.name || '—'} · {t.email || 'sin correo'}</div>
        </div>
      </div>

      {/* Controls */}
      <div class="flex flex-wrap items-center gap-2 py-3 border-b bordered">
        <label class="text-[12px] text-faint">Estado</label>
        <select class="input" value={t.status} disabled={busy} onChange={(e) => patch({ status: (e.target as HTMLSelectElement).value })}>
          {Object.keys(STATUS_LABEL).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <label class="text-[12px] text-faint ml-2">Prioridad</label>
        <select class="input" value={t.priority} disabled={busy} onChange={(e) => patch({ priority: (e.target as HTMLSelectElement).value })}>
          {Object.keys(PRIORITY_LABEL).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
        </select>
        <button class="btn btn-outline btn-sm ml-auto" disabled={busy} onClick={() => patch({ assigned_to: 'me' })}><Icon.userCheck size={14} /> Asignarme</button>
      </div>

      {/* Thread */}
      <div class="flex-1 overflow-y-auto py-4 flex flex-col gap-3">
        {messages.map((m) => (
          <div key={m.id} class={`max-w-[85%] ${m.author_type === 'staff' ? 'self-end items-end' : m.author_type === 'system' ? 'self-center' : 'self-start'} flex flex-col`}>
            <div class={`px-3.5 py-2.5 rounded-xl text-[13px] leading-relaxed whitespace-pre-wrap break-words ${
              m.author_type === 'staff' ? 'bg-info text-white rounded-br-sm'
              : m.author_type === 'system' ? 'text-faint italic text-[12px] text-center'
              : 'surface-subtle bordered rounded-bl-sm'}`}>{m.body}</div>
            {m.author_type !== 'system' && (
              <div class="text-[11px] text-faint mt-1">
                {m.author_type === 'staff' ? (m.author_name || 'Soporte') : (t.name || 'Ciudadano')} · {relTime(m.created_ms)}
                {m.via === 'email' && <span class="ml-1 uppercase tracking-wide opacity-70">correo</span>}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Reply */}
      <div class="pt-3 border-t bordered">
        <textarea class="input w-full" rows={3} placeholder="Escribe tu respuesta al ciudadano…" value={reply}
          disabled={busy} onInput={(e) => setReply((e.target as HTMLTextAreaElement).value)} />
        <div class="flex justify-end gap-2 mt-2">
          <button class="btn btn-primary btn-sm" disabled={busy} onClick={sendReply}><Icon.mail size={14} /> Responder</button>
        </div>
      </div>
    </div>
  );
}

// Persisted inbound-email toggle. Reflects + flips the server feature flag that
// gates the Worker email() handler. Fail-closed: off until an operator enables it.
function InboundEmailToggle() {
  const r = useResource<{ inbound_email_enabled: boolean }>(() => sup('/admin/settings'), []);
  const [busy, setBusy] = useState(false);
  const on = !!r.data?.inbound_email_enabled;

  async function flip() {
    setBusy(true);
    try {
      await sup('/admin/settings', { method: 'PUT', body: JSON.stringify({ inbound_email_enabled: !on }) });
      toast(!on ? 'Respuestas por correo activadas.' : 'Respuestas por correo desactivadas.', 'success');
      r.reload();
    } catch (e: any) { toast(e?.message || 'No se pudo cambiar.', 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div class="card flex items-center gap-3 mb-4 py-3">
      <Icon.mail size={18} class={on ? 'text-ok' : 'text-faint'} />
      <div class="min-w-0 flex-1">
        <div class="font-medium text-[14px]">Respuestas por correo (inbound)</div>
        <div class="text-[12px] text-faint">
          {on
            ? 'Activado: los correos de respuesta se adjuntan al ticket. Requiere la regla de Email Routing (soporte@ → Worker).'
            : 'Desactivado: los correos entrantes se ignoran. Actívalo cuando la regla de Email Routing esté lista.'}
        </div>
      </div>
      <button class={`btn btn-sm ${on ? 'btn-outline text-danger' : 'btn-primary'}`} disabled={busy || r.loading} onClick={flip}>
        {r.loading ? '…' : on ? 'Desactivar' : 'Activar'}
      </button>
    </div>
  );
}
