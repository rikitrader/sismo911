import { useState } from 'preact/hooks';
import { rbac } from '../api';
import type { UserRow } from '../api';
import { useResource } from '../hooks';
import { PageHeader, Avatar, Field, Spinner } from '../components/ui';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/Confirm';
import { ForbiddenInline, ErrorInline } from '../components/StateScreens';
import { Icon } from '../icons';
import { relTime } from '../util';
import { toast } from '../toast';

export function ApprovalsPage() {
  const r = useResource(() => rbac.approvals(), []);
  const [approving, setApproving] = useState<UserRow | null>(null);
  const [rejecting, setRejecting] = useState<UserRow | null>(null);

  const rows: UserRow[] = (r.data?.users || r.data?.approvals || []) as UserRow[];

  const columns: Column<UserRow>[] = [
    {
      key: 'user', header: 'Usuario', render: (u) => (
        <div class="flex items-center gap-3 min-w-0">
          <Avatar name={u.name || u.preferred_name} email={u.email} size={32} />
          <div class="min-w-0">
            <div class="font-medium truncate">{u.preferred_name || u.name || u.username || u.email}</div>
            <div class="text-[12px] text-faint truncate">{u.email}</div>
          </div>
        </div>
      ),
    },
    { key: 'job', header: 'Cargo', width: '22%', render: (u) => <span class="text-muted">{u.job_title || '—'}</span> },
    {
      key: 'roles', header: 'Roles solicitados', width: '22%', render: (u) => (
        <div class="flex flex-wrap gap-1">
          {u.roles?.length ? u.roles.slice(0, 3).map((rk) => <span key={rk} class="pill surface-subtle bordered text-muted">{rk}</span>) : <span class="text-faint">—</span>}
        </div>
      ),
    },
    {
      key: 'actions', header: '', width: '210px', align: 'right', render: (u) => (
        <div class="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          <button class="btn btn-outline btn-sm text-danger" onClick={() => setRejecting(u)}><Icon.ban size={14} /> Rechazar</button>
          <button class="btn btn-primary btn-sm" onClick={() => setApproving(u)}><Icon.check size={14} /> Aprobar</button>
        </div>
      ),
    },
  ];

  const name = (u: UserRow | null) => u ? (u.preferred_name || u.name || u.username || u.email) : '';

  return (
    <div class="animate-fade-in">
      <PageHeader
        title="Aprobaciones"
        subtitle="Usuarios pendientes de aprobación"
        actions={<button class="btn btn-ghost btn-sm" onClick={r.reload} aria-label="Recargar"><Icon.refresh size={15} /> Recargar</button>}
      />
      {r.forbidden ? <ForbiddenInline /> : r.error ? <ErrorInline message={r.error} onRetry={r.reload} /> : (
        <DataTable
          rows={rows}
          columns={columns}
          loading={r.loading}
          search
          searchKeys={['email', 'name', 'preferred_name', 'username']}
          emptyTitle="Nada por aprobar"
          emptyHint="No hay usuarios pendientes de aprobación en este momento."
        />
      )}

      <ConfirmDialog
        open={!!approving}
        onClose={() => setApproving(null)}
        title="Aprobar usuario"
        confirmLabel="Aprobar"
        successMsg="Usuario aprobado"
        body={<>Se activará la cuenta de <b>{name(approving)}</b> y podrá iniciar sesión.</>}
        onConfirm={async () => { if (approving) { await rbac.approveUser(approving.id); r.reload(); } }}
      />

      <RejectModal user={rejecting} onClose={() => setRejecting(null)} onDone={r.reload} />
    </div>
  );
}

function RejectModal({ user, onClose, onDone }: { user: UserRow | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const open = !!user;
  const name = user ? (user.preferred_name || user.name || user.username || user.email) : '';

  async function run() {
    if (!user) return;
    setBusy(true);
    try {
      await rbac.rejectUser(user.id, reason.trim() || undefined);
      toast.success('Usuario rechazado');
      setReason('');
      onDone();
      onClose();
    } catch (e: any) {
      toast.error(e?.message || 'No se pudo rechazar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title="Rechazar usuario"
      footer={
        <>
          <button class="btn btn-ghost" disabled={busy} onClick={onClose}>Cancelar</button>
          <button class="btn btn-danger" disabled={busy} onClick={run}>{busy ? <Spinner /> : <Icon.ban size={15} />} Rechazar</button>
        </>
      }>
      <div class="space-y-4">
        <p class="text-[13.5px] text-muted leading-relaxed">Se rechazará la solicitud de <b>{name}</b>. Esta acción se registra en la auditoría.</p>
        <Field label="Motivo (opcional)">
          <textarea class="input" rows={3} value={reason} placeholder="Por qué se rechaza esta solicitud…" onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)} />
        </Field>
      </div>
    </Modal>
  );
}
