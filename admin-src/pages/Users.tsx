import { useEffect, useState } from 'preact/hooks';
import { rbac } from '../api';
import type { UserRow, Permission } from '../api';
import { useResource } from '../hooks';
import { PageHeader, Avatar, StatusPill, Spinner, Field, EmptyState } from '../components/ui';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { Drawer, Tabs } from '../components/Drawer';
import { Modal } from '../components/Modal';
import { ForbiddenInline, ErrorInline } from '../components/StateScreens';
import { Icon } from '../icons';
import { relTime, fullTime } from '../util';
import { toast } from '../toast';

export function UsersPage() {
  const [status, setStatus] = useState('');
  const r = useResource(() => rbac.users('', status), [status]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [invite, setInvite] = useState(false);

  // Quick-action from command palette.
  useEffect(() => {
    const h = () => setInvite(true);
    addEventListener('rbac-action:invite', h);
    return () => removeEventListener('rbac-action:invite', h);
  }, []);

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
    { key: 'job', header: 'Cargo', width: '20%', render: (u) => <span class="text-muted">{u.job_title || '—'}</span> },
    {
      key: 'roles', header: 'Roles', width: '20%', render: (u) => (
        <div class="flex flex-wrap gap-1">
          {u.roles?.length ? u.roles.slice(0, 3).map((rk) => (
            <span key={rk} class="pill surface-subtle bordered text-muted">{rk}</span>
          )) : <span class="text-faint">—</span>}
          {u.roles?.length > 3 && <span class="pill surface-subtle bordered text-faint">+{u.roles.length - 3}</span>}
        </div>
      ),
    },
    { key: 'status', header: 'Estado', width: '120px', render: (u) => <StatusPill status={u.status} /> },
    { key: 'last', header: 'Último acceso', width: '130px', align: 'right', render: (u) => <span class="text-faint">{relTime(u.last_login_ms)}</span> },
  ];

  return (
    <div class="animate-fade-in">
      <PageHeader
        title="Usuarios"
        subtitle="Cuentas, roles y permisos directos"
        actions={<button class="btn btn-primary" onClick={() => setInvite(true)}><Icon.plus size={16} /> Invitar usuario</button>}
      />
      {r.forbidden ? <ForbiddenInline /> : r.error ? <ErrorInline message={r.error} onRetry={r.reload} /> : (
        <DataTable
          rows={r.data?.users || []}
          columns={columns}
          loading={r.loading}
          search
          searchKeys={['email', 'name', 'preferred_name', 'username', 'job_title']}
          onRowClick={(u) => setOpenId(u.id)}
          filters={[
            { label: 'Todos', value: '' },
            { label: 'Activos', value: 'active' },
            { label: 'Suspendidos', value: 'suspended' },
            { label: 'Pendientes', value: 'pending' },
          ]}
          filterValue={status}
          onFilter={setStatus}
          emptyTitle="No hay usuarios"
          emptyHint="Invita a tu primer administrador para empezar."
        />
      )}

      {openId && <UserDrawer id={openId} onClose={() => setOpenId(null)} onChanged={r.reload} />}
      <InviteModal open={invite} onClose={() => setInvite(false)} onDone={r.reload} />
    </div>
  );
}

// ---------- User detail drawer ----------
function UserDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const r = useResource(() => rbac.user(id), [id]);
  const [tab, setTab] = useState<'overview' | 'roles' | 'permissions'>('overview');
  const [busy, setBusy] = useState(false);

  const reloadAll = () => { r.reload(); onChanged(); };

  async function act(fn: () => Promise<any>, ok: string) {
    setBusy(true);
    try { await fn(); toast.success(ok); reloadAll(); }
    catch (e: any) { toast.error(e?.message || 'No se pudo completar la acción'); }
    finally { setBusy(false); }
  }

  const u = r.data?.user;
  const name = u ? (u.preferred_name || u.name || u.username || u.email) : 'Usuario';

  return (
    <Drawer
      open
      onClose={onClose}
      width={520}
      title={r.loading ? <span class="skeleton inline-block h-4 w-32 align-middle" /> : name}
      subtitle={u?.email}
      footer={u && (
        <div class="flex items-center justify-between">
          <span class="text-[12px] text-faint">ID {u.id.slice(0, 10)}…</span>
          {u.status === 'suspended'
            ? <button class="btn btn-outline btn-sm" disabled={busy} onClick={() => act(() => rbac.activate(u.id), 'Usuario activado')}>{busy ? <Spinner /> : <Icon.check size={15} />} Activar</button>
            : <button class="btn btn-danger btn-sm" disabled={busy} onClick={() => act(() => rbac.suspend(u.id), 'Usuario suspendido')}>{busy ? <Spinner /> : <Icon.lock size={15} />} Suspender</button>}
        </div>
      )}
    >
      {r.forbidden ? <div class="p-5"><ForbiddenInline /></div>
        : r.error ? <div class="p-5"><ErrorInline message={r.error} onRetry={r.reload} /></div>
        : (
        <>
          <Tabs
            active={tab}
            onChange={(t) => setTab(t as any)}
            tabs={[{ id: 'overview', label: 'Resumen' }, { id: 'permissions', label: 'Permisos' }, { id: 'roles', label: 'Roles' }]}
          />
          <div class="p-5">
            {tab === 'overview' && <Overview r={r} />}
            {tab === 'roles' && <RolesTab r={r} busy={busy} act={act} />}
            {tab === 'permissions' && <PermsTab r={r} busy={busy} act={act} />}
          </div>
        </>
      )}
    </Drawer>
  );
}

function HeaderCard({ r }: { r: any }) {
  const u = r.data.user;
  return (
    <div class="flex items-center gap-3.5 mb-5">
      <Avatar name={u.name} email={u.email} size={52} />
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <span class="font-semibold text-[15px] truncate">{u.preferred_name || u.name || u.email}</span>
          <StatusPill status={u.status} />
        </div>
        <div class="text-[13px] text-faint truncate">{u.job_title || u.username || u.email}</div>
      </div>
    </div>
  );
}

function Overview({ r }: { r: any }) {
  if (r.loading) return <div class="space-y-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} class="skeleton h-4" style={{ width: `${60 + (i % 3) * 12}%` }} />)}</div>;
  const u = r.data.user;
  const items = [
    ['Correo', u.email], ['Usuario', u.username], ['Nombre', u.name], ['Cargo', u.job_title],
    ['Departamento', u.department_id], ['Tipo de empleo', u.employment_type],
    ['Último acceso', u.last_login_ms ? fullTime(u.last_login_ms) : '—'],
  ].filter(([, v]) => v);
  return (
    <>
      <HeaderCard r={r} />
      <dl class="grid grid-cols-1 gap-px surface-subtle bordered rounded-lg overflow-hidden">
        {items.map(([k, v]) => (
          <div key={k as string} class="flex items-center justify-between gap-4 px-3.5 py-2.5 surface">
            <dt class="text-[12.5px] text-faint">{k}</dt>
            <dd class="text-[13px] font-medium text-right truncate">{v as string}</dd>
          </div>
        ))}
      </dl>
      <div class="mt-5">
        <div class="label-caps mb-2">Permisos efectivos · {r.data.effectivePermissions?.length || 0}</div>
        <div class="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
          {r.data.effectivePermissions?.length ? r.data.effectivePermissions.map((p: string) => (
            <span key={p} class="pill surface-subtle bordered text-muted font-mono text-[11px]">{p}</span>
          )) : <span class="text-faint text-[13px]">Sin permisos efectivos.</span>}
        </div>
      </div>
    </>
  );
}

function RolesTab({ r, busy, act }: { r: any; busy: boolean; act: any }) {
  const rolesRes = useResource(() => rbac.roles(), []);
  const [pick, setPick] = useState('');
  if (r.loading) return <div class="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} class="skeleton h-11 rounded-lg" />)}</div>;
  const assigned = r.data.roles || [];
  const assignedKeys = new Set(assigned.map((x: any) => x.key));
  const available = (rolesRes.data?.roles || []).filter((x) => !assignedKeys.has(x.key));
  return (
    <div>
      <div class="label-caps mb-2">Roles asignados · {assigned.length}</div>
      {assigned.length ? (
        <ul class="space-y-2 mb-5">
          {assigned.map((role: any) => (
            <li key={role.id} class="flex items-center gap-3 surface-subtle bordered rounded-lg px-3 py-2.5">
              <span class="w-7 h-7 rounded-md surface flex items-center justify-center text-faint shrink-0"><Icon.roles size={15} /></span>
              <div class="min-w-0 flex-1"><div class="text-[13px] font-medium truncate">{role.name}</div><div class="text-[11.5px] text-faint font-mono truncate">{role.key}</div></div>
              <button class="btn btn-ghost btn-sm px-2 text-faint hover:text-danger" disabled={busy} aria-label="Quitar rol"
                onClick={() => act(() => rbac.removeRole(r.data.user.id, role.id), 'Rol removido')}><Icon.close size={15} /></button>
            </li>
          ))}
        </ul>
      ) : <p class="text-faint text-[13px] mb-5">Este usuario no tiene roles asignados.</p>}

      <div class="label-caps mb-2">Asignar rol</div>
      <div class="flex gap-2">
        <select class="input flex-1" value={pick} onChange={(e) => setPick((e.target as HTMLSelectElement).value)} aria-label="Seleccionar rol">
          <option value="">Seleccionar rol…</option>
          {available.map((x) => <option key={x.key} value={x.key}>{x.name} ({x.key})</option>)}
        </select>
        <button class="btn btn-primary" disabled={!pick || busy} onClick={() => { act(() => rbac.assignRole(r.data.user.id, pick), 'Rol asignado'); setPick(''); }}>Asignar</button>
      </div>
    </div>
  );
}

function PermsTab({ r, busy, act }: { r: any; busy: boolean; act: any }) {
  const permsRes = useResource(() => rbac.permissions(), []);
  if (r.loading || permsRes.loading) return <div class="space-y-2">{Array.from({ length: 5 }).map((_, i) => <div key={i} class="skeleton h-9 rounded-lg" />)}</div>;
  const direct = new Map<string, 'allow' | 'deny'>((r.data.directPermissions || []).map((d: any) => [d.perm_key, d.effect]));
  const categories = permsRes.data?.categories || {};
  const uid = r.data.user.id;

  return (
    <div class="space-y-5">
      <p class="text-[12.5px] text-faint">Las concesiones directas anulan los permisos heredados por rol.</p>
      {Object.entries(categories).map(([cat, perms]) => (
        <div key={cat}>
          <div class="label-caps mb-2">{cat}</div>
          <div class="surface-subtle bordered rounded-lg divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
            {(perms as Permission[]).map((p) => {
              const eff = direct.get(p.key);
              return (
                <div key={p.key} class="flex items-center gap-3 px-3 py-2 surface">
                  <div class="min-w-0 flex-1"><div class="text-[13px] truncate">{p.label}</div><div class="text-[11px] text-faint font-mono truncate">{p.key}</div></div>
                  <div class="flex items-center gap-1 shrink-0">
                    <SegBtn on={eff === 'allow'} tone="ok" label="Permitir" disabled={busy} onClick={() => act(() => rbac.setPermission(uid, p.key, 'allow'), 'Permiso concedido')} />
                    <SegBtn on={eff === 'deny'} tone="danger" label="Denegar" disabled={busy} onClick={() => act(() => rbac.setPermission(uid, p.key, 'deny'), 'Permiso denegado')} />
                    {eff && <button class="btn btn-ghost btn-sm px-1.5 text-faint" aria-label="Restablecer" disabled={busy} onClick={() => act(() => rbac.removePermission(uid, p.key), 'Restablecido a heredado')}><Icon.close size={14} /></button>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {Object.keys(categories).length === 0 && <EmptyState title="Sin catálogo de permisos" icon="permissions" />}
    </div>
  );
}

function SegBtn({ on, tone, label, disabled, onClick }: { on: boolean; tone: 'ok' | 'danger'; label: string; disabled?: boolean; onClick: () => void }) {
  const active = tone === 'ok' ? 'bg-ok/15 text-ok border-ok/30' : 'bg-danger/15 text-danger border-danger/30';
  return (
    <button class={`text-[11.5px] font-semibold h-7 px-2.5 rounded-md border transition-colors ${on ? active : 'border-transparent text-faint hover:bg-[rgb(var(--bg-hover))]'}`} aria-pressed={on} disabled={disabled} onClick={onClick}>{label}</button>
  );
}

// ---------- Invite ----------
function InviteModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const rolesRes = useResource(() => rbac.roles(), [open]);

  useEffect(() => { if (open) { setEmail(''); setRoleKey(''); setLink(null); } }, [open]);

  async function submit() {
    if (!email.trim()) return;
    setBusy(true);
    try {
      const res = await rbac.invite(email.trim(), roleKey || undefined);
      const url = `${location.origin}/invite/${res.token}`;
      setLink(url);
      toast.success('Invitación creada');
      onDone();
    } catch (e: any) { toast.error(e?.message || 'No se pudo crear la invitación'); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Invitar usuario"
      footer={!link && <><button class="btn btn-ghost" onClick={onClose}>Cancelar</button><button class="btn btn-primary" disabled={busy || !email.trim()} onClick={submit}>{busy ? <Spinner /> : <Icon.plus size={16} />} Enviar invitación</button></>}>
      {link ? (
        <div class="text-center py-2">
          <div class="w-12 h-12 rounded-xl bg-ok/12 text-ok flex items-center justify-center mx-auto mb-3"><Icon.check size={24} /></div>
          <p class="font-medium text-[14px]">Invitación lista</p>
          <p class="text-faint text-[12.5px] mt-1 mb-4">Comparte este enlace con {email}.</p>
          <div class="flex items-center gap-2 surface-subtle bordered rounded-lg px-3 py-2 text-left">
            <Icon.link size={15} class="text-faint shrink-0" />
            <span class="text-[12px] font-mono truncate flex-1">{link}</span>
            <button class="btn btn-ghost btn-sm px-2" aria-label="Copiar" onClick={() => { navigator.clipboard?.writeText(link); toast.success('Enlace copiado'); }}><Icon.copy size={15} /></button>
          </div>
          <button class="btn btn-outline w-full mt-4" onClick={onClose}>Listo</button>
        </div>
      ) : (
        <div class="space-y-4">
          <Field label="Correo electrónico">
            <input class="input" type="email" placeholder="persona@sismo911.com" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </Field>
          <Field label="Rol inicial (opcional)">
            <select class="input" value={roleKey} onChange={(e) => setRoleKey((e.target as HTMLSelectElement).value)}>
              <option value="">Sin rol</option>
              {(rolesRes.data?.roles || []).map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}
            </select>
          </Field>
        </div>
      )}
    </Modal>
  );
}
