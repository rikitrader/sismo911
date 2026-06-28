import { useEffect, useState } from 'preact/hooks';
import { rbac } from '../api';
import type { Invitation } from '../api';
import { useResource } from '../hooks';
import { PageHeader } from '../components/ui';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { InviteModal } from '../components/InviteModal';
import { ConfirmDialog } from '../components/Confirm';
import { ForbiddenInline, ErrorInline } from '../components/StateScreens';
import { Icon } from '../icons';
import { relTime } from '../util';
import { toast } from '../toast';

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Pendiente', cls: 'bg-warn/15 text-warn' },
  accepted: { label: 'Aceptada', cls: 'bg-ok/12 text-ok' },
  revoked: { label: 'Revocada', cls: 'bg-danger/12 text-danger' },
  expired: { label: 'Expirada', cls: 'text-faint surface-subtle' },
};

const CHANNEL_META: Record<string, { label: string; icon: keyof typeof Icon }> = {
  email: { label: 'Correo', icon: 'mail' },
  sms: { label: 'SMS', icon: 'phone' },
  qr: { label: 'QR', icon: 'permissions' },
};

function StatusPill({ status }: { status?: string }) {
  const m = STATUS_META[status || 'pending'] || STATUS_META.pending;
  return <span class={`pill ${m.cls}`}>{m.label}</span>;
}

function inviteLink(inv: Invitation): string {
  return inv.link || (inv.token ? `${location.origin}/invite/${inv.token}` : '');
}

export function InvitationsPage() {
  const [status, setStatus] = useState('');
  const r = useResource(() => rbac.invitations(status), [status]);
  const [invite, setInvite] = useState(false);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Quick-action from the command palette.
  useEffect(() => {
    const h = () => setInvite(true);
    addEventListener('rbac-action:invite', h);
    return () => removeEventListener('rbac-action:invite', h);
  }, []);

  async function resend(inv: Invitation) {
    setBusyId(inv.id);
    try { await rbac.resendInvitation(inv.id); toast.success('Invitación reenviada'); r.reload(); }
    catch (e: any) { toast.error(e?.message || 'No se pudo reenviar'); }
    finally { setBusyId(null); }
  }

  const columns: Column<Invitation>[] = [
    {
      key: 'email', header: 'Invitado', render: (inv) => (
        <div class="min-w-0">
          <div class="font-medium truncate">{inv.email}</div>
          {(inv.role_key || inv.roleKey) && <div class="text-[11.5px] text-faint font-mono truncate">{inv.role_key || inv.roleKey}</div>}
        </div>
      ),
    },
    {
      key: 'channel', header: 'Canal', width: '120px', render: (inv) => {
        const m = CHANNEL_META[inv.channel || 'email'] || CHANNEL_META.email;
        const I = Icon[m.icon];
        return <span class="inline-flex items-center gap-1.5 text-muted"><I size={14} />{m.label}</span>;
      },
    },
    { key: 'status', header: 'Estado', width: '120px', render: (inv) => <StatusPill status={inv.status} /> },
    { key: 'created', header: 'Creada', width: '120px', render: (inv) => <span class="text-faint">{relTime(inv.created_ms)}</span> },
    {
      key: 'actions', header: '', width: '170px', align: 'right', render: (inv) => {
        const link = inviteLink(inv);
        const active = !inv.status || inv.status === 'pending';
        return (
          <div class="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            {link && (
              <button class="btn btn-ghost btn-sm px-2 text-faint" aria-label="Copiar enlace"
                onClick={() => { navigator.clipboard?.writeText(link); toast.success('Enlace copiado'); }}><Icon.copy size={15} /></button>
            )}
            {active && (
              <>
                <button class="btn btn-ghost btn-sm px-2 text-faint" aria-label="Reenviar" disabled={busyId === inv.id} onClick={() => resend(inv)}><Icon.refresh size={15} /></button>
                <button class="btn btn-ghost btn-sm px-2 text-faint hover:text-danger" aria-label="Revocar" onClick={() => setRevoking(inv)}><Icon.ban size={15} /></button>
              </>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div class="animate-fade-in">
      <PageHeader
        title="Invitaciones"
        subtitle="Invita usuarios por correo, SMS o código QR"
        actions={<button class="btn btn-primary" onClick={() => setInvite(true)}><Icon.plus size={16} /> Invitar usuario</button>}
      />
      {r.forbidden ? <ForbiddenInline /> : r.error ? <ErrorInline message={r.error} onRetry={r.reload} /> : (
        <DataTable
          rows={r.data?.invitations || []}
          columns={columns}
          loading={r.loading}
          search
          searchKeys={['email']}
          filters={[
            { label: 'Todas', value: '' },
            { label: 'Pendientes', value: 'pending' },
            { label: 'Aceptadas', value: 'accepted' },
            { label: 'Revocadas', value: 'revoked' },
          ]}
          filterValue={status}
          onFilter={setStatus}
          emptyTitle="No hay invitaciones"
          emptyHint="Invita a alguien para empezar — por correo, SMS o un código QR para escanear."
        />
      )}

      <InviteModal open={invite} onClose={() => setInvite(false)} onDone={r.reload} />

      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title="Revocar invitación"
        danger
        confirmLabel="Revocar"
        successMsg="Invitación revocada"
        body={<>El enlace de invitación de <b>{revoking?.email}</b> dejará de funcionar de inmediato.</>}
        onConfirm={async () => { if (revoking) { await rbac.revokeInvitation(revoking.id); r.reload(); } }}
      />
    </div>
  );
}
