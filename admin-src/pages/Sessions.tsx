import { useState } from 'preact/hooks';
import { rbac } from '../api';
import type { SessionRow } from '../api';
import { useResource } from '../hooks';
import { PageHeader, EmptyState, Spinner } from '../components/ui';
import { ForbiddenInline, ErrorInline } from '../components/StateScreens';
import { ConfirmDialog } from '../components/Confirm';
import { Icon } from '../icons';
import { relTime, fullTime } from '../util';

function deviceLabel(s: SessionRow): string {
  if (s.device_label) return s.device_label;
  const ua = s.user_agent || '';
  if (/iphone|android|mobile/i.test(ua)) return 'Dispositivo móvil';
  if (/mac|windows|linux/i.test(ua)) return 'Computadora de escritorio';
  return ua ? ua.slice(0, 40) : 'Sesión';
}
const isCurrent = (s: SessionRow) => Boolean(s.current ?? s.is_current);
const ipOf = (s: SessionRow) => s.ip || s.ip_address || '—';

// Reusable list of sessions with per-row revoke + optional "revoke all".
export function SessionList({
  sessions, loading, onRevoke, onRevokeAll, allowRevokeCurrent = false,
}: {
  sessions: SessionRow[];
  loading?: boolean;
  onRevoke: (s: SessionRow) => Promise<unknown>;
  onRevokeAll?: () => Promise<unknown>;
  allowRevokeCurrent?: boolean;
}) {
  const [confirm, setConfirm] = useState<SessionRow | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  if (loading) {
    return (
      <div class="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} class="skeleton h-[58px] rounded-lg" />)}
      </div>
    );
  }
  if (!sessions.length) {
    return <EmptyState title="Sin sesiones activas" hint="No hay sesiones abiertas en este momento." icon="sessions" />;
  }

  return (
    <div>
      {onRevokeAll && sessions.length > 1 && (
        <div class="flex justify-end mb-3">
          <button class="btn btn-danger btn-sm" onClick={() => setConfirmAll(true)}>
            <Icon.trash size={14} /> Revocar todas
          </button>
        </div>
      )}
      <ul class="space-y-2">
        {sessions.map((s) => {
          const cur = isCurrent(s);
          return (
            <li key={s.token} class="flex items-center gap-3 surface-subtle bordered rounded-lg px-3.5 py-2.5">
              <span class="w-9 h-9 rounded-md surface flex items-center justify-center text-faint shrink-0">
                {/iphone|android|mobile/i.test(s.user_agent || s.device_label || '') ? <Icon.phone size={17} /> : <Icon.device size={17} />}
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-[13px] font-medium truncate">{deviceLabel(s)}</span>
                  {cur && <span class="pill bg-ok/12 text-ok"><span class="pill-dot bg-ok" />Actual</span>}
                </div>
                <div class="text-[11.5px] text-faint truncate">
                  <span class="font-mono">{ipOf(s)}</span>
                  {s.last_seen_ms != null && <span> · visto {relTime(s.last_seen_ms)}</span>}
                  {s.created_ms != null && <span title={fullTime(s.created_ms)}> · iniciada {relTime(s.created_ms)}</span>}
                </div>
              </div>
              {(allowRevokeCurrent || !cur) && (
                <button
                  class="btn btn-ghost btn-sm px-2 text-faint hover:text-danger shrink-0"
                  aria-label="Revocar sesión"
                  onClick={() => setConfirm(s)}
                >
                  <Icon.trash size={15} />
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Revocar sesión"
        danger
        confirmLabel="Revocar"
        successMsg="Sesión revocada"
        body={<>Se cerrará la sesión en <b>{confirm ? deviceLabel(confirm) : ''}</b> ({confirm ? ipOf(confirm) : ''}). El dispositivo tendrá que iniciar sesión de nuevo.</>}
        onConfirm={() => onRevoke(confirm!)}
      />
      {onRevokeAll && (
        <ConfirmDialog
          open={confirmAll}
          onClose={() => setConfirmAll(false)}
          title="Revocar todas las sesiones"
          danger
          confirmLabel="Revocar todas"
          successMsg="Sesiones revocadas"
          body="Se cerrarán todas las sesiones de este usuario en todos los dispositivos."
          onConfirm={() => onRevokeAll()}
        />
      )}
    </div>
  );
}

// Per-user sessions (used inside the User drawer).
export function UserSessions({ userId }: { userId: string }) {
  const r = useResource(() => rbac.userSessions(userId), [userId]);
  if (r.forbidden) return <ForbiddenInline message="No puedes ver las sesiones de este usuario." />;
  if (r.error) return <ErrorInline message={r.error} onRetry={r.reload} />;
  const sessions = r.data?.sessions || [];
  return (
    <div>
      <div class="label-caps mb-2">Sesiones activas · {sessions.length}</div>
      <SessionList
        sessions={sessions}
        loading={r.loading}
        allowRevokeCurrent
        onRevoke={async (s) => { await rbac.revokeUserSession(userId, s.token); r.reload(); }}
        onRevokeAll={async () => { await rbac.revokeAllUserSessions(userId); r.reload(); }}
      />
    </div>
  );
}

// Own sessions page.
export function SessionsPage() {
  const r = useResource(() => rbac.sessions(), []);
  const sessions = r.data?.sessions || [];
  return (
    <div class="animate-fade-in">
      <PageHeader
        title="Sesiones"
        subtitle="Tus sesiones activas en todos los dispositivos"
        actions={<button class="btn btn-ghost btn-sm" onClick={r.reload} aria-label="Recargar">{r.loading ? <Spinner /> : <Icon.refresh size={15} />}</button>}
      />
      {r.forbidden ? <ForbiddenInline /> : r.error ? <ErrorInline message={r.error} onRetry={r.reload} /> : (
        <div class="card p-4">
          <SessionList
            sessions={sessions}
            loading={r.loading}
            onRevoke={async (s) => { await rbac.revokeSession(s.token); r.reload(); }}
          />
        </div>
      )}
    </div>
  );
}
