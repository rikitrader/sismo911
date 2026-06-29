import { useEffect, useMemo, useState } from 'preact/hooks';
import { rbac } from '../api';
import type { UserRow, Permission, TempRole, EffectivePermissions } from '../api';
import { useResource } from '../hooks';
import { PageHeader, Avatar, StatusPill, Spinner, EmptyState } from '../components/ui';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { Drawer, Tabs } from '../components/Drawer';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/Confirm';
import { InviteModal } from '../components/InviteModal';
import { UserSessions } from './Sessions';
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
  const [tab, setTab] = useState<'overview' | 'roles' | 'permissions' | 'sessions' | 'audit'>('overview');
  const [busy, setBusy] = useState(false);
  const [confirmLock, setConfirmLock] = useState(false);
  const [impersonate, setImpersonate] = useState(false);

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
        <div class="flex items-center justify-between gap-2">
          <button class="btn btn-ghost btn-sm text-warn px-2" disabled={busy} onClick={() => setImpersonate(true)}><Icon.mask size={15} /> Suplantar</button>
          <div class="flex items-center gap-2">
            {u.status === 'locked'
              ? <button class="btn btn-outline btn-sm" disabled={busy} onClick={() => act(() => rbac.unlock(u.id), 'Cuenta desbloqueada')}>{busy ? <Spinner /> : <Icon.unlock size={15} />} Desbloquear</button>
              : <button class="btn btn-danger btn-sm" disabled={busy} onClick={() => setConfirmLock(true)}><Icon.lock size={15} /> Bloqueo de emergencia</button>}
            {u.status === 'suspended'
              ? <button class="btn btn-outline btn-sm" disabled={busy} onClick={() => act(() => rbac.activate(u.id), 'Usuario activado')}>{busy ? <Spinner /> : <Icon.check size={15} />} Activar</button>
              : u.status !== 'locked' && <button class="btn btn-danger btn-sm" disabled={busy} onClick={() => act(() => rbac.suspend(u.id), 'Usuario suspendido')}>{busy ? <Spinner /> : <Icon.lock size={15} />} Suspender</button>}
          </div>
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
            tabs={[{ id: 'overview', label: 'Resumen' }, { id: 'permissions', label: 'Permisos' }, { id: 'roles', label: 'Roles' }, { id: 'sessions', label: 'Sesiones' }, { id: 'audit', label: 'Auditoría' }]}
          />
          <div class="p-5">
            {tab === 'overview' && <Overview r={r} />}
            {tab === 'roles' && <RolesTab r={r} busy={busy} act={act} />}
            {tab === 'permissions' && <PermsTab r={r} busy={busy} act={act} />}
            {tab === 'sessions' && (r.loading ? <div class="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} class="skeleton h-[58px] rounded-lg" />)}</div> : <UserSessions userId={id} />)}
            {tab === 'audit' && <UserAudit userId={id} />}
          </div>
        </>
      )}

      {u && (
        <ConfirmDialog
          open={confirmLock}
          onClose={() => setConfirmLock(false)}
          title="Bloqueo de emergencia"
          danger
          confirmLabel="Bloquear cuenta"
          successMsg="Cuenta bloqueada"
          body={<>Se bloqueará la cuenta de <b>{name}</b> de inmediato y se cerrarán sus sesiones. Úsalo solo ante una amenaza activa.</>}
          onConfirm={async () => { await rbac.lock(u.id); reloadAll(); }}
        />
      )}

      {u && <ImpersonateModal open={impersonate} onClose={() => setImpersonate(false)} userId={u.id} name={name} />}
    </Drawer>
  );
}

// ---------- Impersonation ----------
function ImpersonateModal({ open, onClose, userId, name }: { open: boolean; onClose: () => void; userId: string; name: string }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) setReason(''); }, [open]);

  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      await rbac.impersonate(userId, reason.trim());
      // The server set the `sismo_impersonating` cookie; reload so the entire
      // console (and the warning banner) reflects the impersonated context.
      dispatchEvent(new CustomEvent('rbac-impersonation-changed'));
      toast.success('Suplantación iniciada');
      location.reload();
    } catch (e: any) {
      toast.error(e?.message || 'No se pudo iniciar la suplantación');
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title="Suplantar usuario"
      footer={
        <>
          <button class="btn btn-ghost" disabled={busy} onClick={onClose}>Cancelar</button>
          <button class="btn btn-danger" disabled={busy} onClick={run}>{busy ? <Spinner /> : <Icon.mask size={15} />} Suplantar</button>
        </>
      }>
      <div class="space-y-4">
        <div class="flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5">
          <span class="text-warn shrink-0 mt-0.5"><Icon.alert size={16} /></span>
          <p class="text-[12.5px] text-muted leading-relaxed">
            Vas a ver y operar el sistema <b>como {name}</b>. Cada acción quedará registrada en la auditoría.
            Aparecerá un aviso permanente hasta que detengas la suplantación.
          </p>
        </div>
        <label class="block">
          <span class="label-caps block mb-1.5">Motivo</span>
          <textarea class="input" rows={3} value={reason} placeholder="Por qué necesitas suplantar a este usuario…" onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)} />
        </label>
      </div>
    </Modal>
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
  const allRoles = rolesRes.data?.roles || [];
  const available = allRoles.filter((x) => !assignedKeys.has(x.key));
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

      <div class="border-t mt-6 pt-5" style={{ borderColor: 'rgb(var(--border))' }}>
        <TempRolesSection userId={r.data.user.id} roleOptions={allRoles} onChanged={r.reload} />
      </div>
    </div>
  );
}

// Relative "time remaining" until an expiry timestamp.
function remaining(ms?: number | null): { label: string; expired: boolean } {
  if (!ms) return { label: 'sin vencimiento', expired: false };
  const diff = ms - Date.now();
  if (diff <= 0) return { label: 'expirado', expired: true };
  const m = Math.floor(diff / 60000);
  if (m < 60) return { label: `vence en ${m}m`, expired: false };
  const h = Math.floor(m / 60);
  if (h < 24) return { label: `vence en ${h}h`, expired: false };
  const d = Math.floor(h / 24);
  return { label: `vence en ${d}d`, expired: false };
}

const TEMP_PRESETS: { label: string; ms: number }[] = [
  { label: '1 hora', ms: 3600_000 },
  { label: '8 horas', ms: 8 * 3600_000 },
  { label: '24 horas', ms: 24 * 3600_000 },
  { label: '7 días', ms: 7 * 24 * 3600_000 },
];

function TempRolesSection({ userId, roleOptions, onChanged }: { userId: string; roleOptions: { key: string; name: string }[]; onChanged: () => void }) {
  const tr = useResource(() => rbac.tempRoles(userId), [userId]);
  const [roleKey, setRoleKey] = useState('');
  const [presetMs, setPresetMs] = useState(TEMP_PRESETS[2].ms);
  const [busy, setBusy] = useState(false);

  const list: TempRole[] = (tr.data?.tempRoles || tr.data?.temp_roles || tr.data?.roles || []) as TempRole[];

  async function add() {
    if (!roleKey || busy) return;
    setBusy(true);
    try {
      await rbac.addTempRole(userId, roleKey, Date.now() + presetMs);
      toast.success('Rol temporal asignado');
      setRoleKey('');
      tr.reload(); onChanged();
    } catch (e: any) { toast.error(e?.message || 'No se pudo asignar el rol temporal'); }
    finally { setBusy(false); }
  }

  async function remove(roleId: string) {
    setBusy(true);
    try { await rbac.removeTempRole(userId, roleId); toast.success('Rol temporal removido'); tr.reload(); onChanged(); }
    catch (e: any) { toast.error(e?.message || 'No se pudo remover'); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div class="flex items-center gap-2 mb-2">
        <Icon.clock size={15} class="text-faint" />
        <span class="label-caps !mb-0">Roles temporales · {list.length}</span>
      </div>
      {tr.forbidden ? (
        <p class="text-faint text-[13px] mb-4">No tienes permiso para ver roles temporales.</p>
      ) : tr.loading ? (
        <div class="space-y-2 mb-4">{Array.from({ length: 2 }).map((_, i) => <div key={i} class="skeleton h-11 rounded-lg" />)}</div>
      ) : list.length ? (
        <ul class="space-y-2 mb-4">
          {list.map((role) => {
            const rem = remaining(role.expires_ms);
            return (
              <li key={role.id} class={`flex items-center gap-3 bordered rounded-lg px-3 py-2.5 ${rem.expired ? 'surface-subtle opacity-70' : 'surface-subtle'}`}>
                <span class="w-7 h-7 rounded-md surface flex items-center justify-center text-faint shrink-0"><Icon.clock size={15} /></span>
                <div class="min-w-0 flex-1">
                  <div class="text-[13px] font-medium truncate">{role.name || role.role_key || role.roleKey || role.key}</div>
                  <div class="text-[11.5px] font-mono truncate text-faint">{role.role_key || role.roleKey || role.key}</div>
                </div>
                <span class={`pill ${rem.expired ? 'bg-danger/12 text-danger' : 'bg-warn/15 text-warn'}`}>{rem.label}</span>
                <button class="btn btn-ghost btn-sm px-2 text-faint hover:text-danger" disabled={busy} aria-label="Quitar rol temporal" onClick={() => remove(role.id)}><Icon.close size={15} /></button>
              </li>
            );
          })}
        </ul>
      ) : <p class="text-faint text-[13px] mb-4">Sin roles temporales.</p>}

      <div class="label-caps mb-2">Asignar rol temporal</div>
      <div class="flex flex-wrap gap-2">
        <select class="input flex-1 min-w-[140px]" value={roleKey} onChange={(e) => setRoleKey((e.target as HTMLSelectElement).value)} aria-label="Rol temporal">
          <option value="">Seleccionar rol…</option>
          {roleOptions.map((x) => <option key={x.key} value={x.key}>{x.name} ({x.key})</option>)}
        </select>
        <select class="input w-[130px]" value={String(presetMs)} onChange={(e) => setPresetMs(Number((e.target as HTMLSelectElement).value))} aria-label="Duración">
          {TEMP_PRESETS.map((p) => <option key={p.ms} value={String(p.ms)}>{p.label}</option>)}
        </select>
        <button class="btn btn-primary" disabled={!roleKey || busy} onClick={add}>{busy ? <Spinner /> : <Icon.clock size={15} />} Asignar</button>
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
      <EffectivePermsInspector userId={uid} />
      <div class="border-t pt-5" style={{ borderColor: 'rgb(var(--border))' }}>
        <div class="label-caps mb-2">Concesiones directas</div>
        <p class="text-[12.5px] text-faint">Las concesiones directas anulan los permisos heredados por rol.</p>
      </div>
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

// ---------- Effective-permissions inspector (troubleshooting view) ----------
function EffectivePermsInspector({ userId }: { userId: string }) {
  const res = useResource<EffectivePermissions>(() => rbac.effectivePermissions(userId), [userId]);
  const [q, setQ] = useState('');

  // perm key → ordered list of source badges.
  const sources = useMemo(() => {
    const m = new Map<string, { label: string; tone: 'role' | 'direct' | 'deny' }[]>();
    const data = res.data;
    if (!data) return m;
    const add = (key: string, badge: { label: string; tone: 'role' | 'direct' | 'deny' }) => {
      const arr = m.get(key) || []; arr.push(badge); m.set(key, arr);
    };
    for (const r of data.bySource?.roles || [])
      for (const p of r.perms || []) add(p, { label: r.role, tone: 'role' });
    for (const d of data.bySource?.direct || [])
      if (d.effect === 'allow') add(d.perm, { label: 'directo', tone: 'direct' });
    return m;
  }, [res.data]);

  if (res.forbidden) {
    return (
      <div>
        <div class="label-caps mb-2 flex items-center gap-2"><Icon.eye size={15} class="text-faint" /> Permisos efectivos</div>
        <p class="text-faint text-[13px]">No tienes permiso para inspeccionar los permisos efectivos.</p>
      </div>
    );
  }
  if (res.loading) {
    return <div class="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} class="skeleton h-8 rounded-lg" />)}</div>;
  }

  const data = res.data;
  const effective = (data?.effective || []).filter((k) => k.toLowerCase().includes(q.toLowerCase()));
  const denied = (data?.bySource?.denied || []).filter((k) => k.toLowerCase().includes(q.toLowerCase()));

  return (
    <div>
      <div class="flex items-center gap-2 mb-2">
        <Icon.eye size={15} class="text-faint" />
        <span class="label-caps !mb-0">Permisos efectivos · {data?.effective?.length || 0}</span>
      </div>
      <div class="relative mb-3">
        <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none"><Icon.search size={14} /></span>
        <input class="input h-8 pl-8 text-[13px]" placeholder="Filtrar permisos…" value={q}
          aria-label="Filtrar permisos efectivos" onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      </div>

      {effective.length === 0 && denied.length === 0 ? (
        <p class="text-faint text-[13px]">{q ? 'Sin coincidencias.' : 'Sin permisos efectivos.'}</p>
      ) : (
        <div class="surface-subtle bordered rounded-lg divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
          {effective.map((key) => {
            const badges = sources.get(key) || [];
            return (
              <div key={key} class="flex items-center gap-2 px-3 py-2 surface">
                <span class="font-mono text-[11.5px] truncate flex-1">{key}</span>
                <div class="flex flex-wrap items-center gap-1 justify-end shrink-0 max-w-[55%]">
                  {badges.length ? badges.map((b, i) => (
                    <span key={i} class={`pill ${b.tone === 'direct' ? 'bg-brand-500/15 text-[rgb(var(--accent))]' : 'bg-ok/12 text-ok'}`}>
                      {b.tone === 'direct' ? <Icon.key size={11} /> : <Icon.roles size={11} />}{b.label}
                    </span>
                  )) : <span class="pill surface-subtle bordered text-faint">heredado</span>}
                </div>
              </div>
            );
          })}
          {denied.map((key) => (
            <div key={'deny-' + key} class="flex items-center gap-2 px-3 py-2 surface">
              <span class="font-mono text-[11.5px] truncate flex-1 line-through text-faint">{key}</span>
              <span class="pill bg-danger/12 text-danger shrink-0"><Icon.ban size={11} />denegado</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Audit tab: a user's audit trail, shown only when THEY opted in ----------
function UserAudit({ userId }: { userId: string }) {
  const r = useResource(() => rbac.userAudit(userId), [userId]);
  if (r.loading) return <div class="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} class="skeleton h-[44px] rounded-lg" />)}</div>;
  if (r.forbidden) return <ForbiddenInline />;
  if (r.error) return <ErrorInline message={r.error} onRetry={r.reload} />;
  if (!r.data?.opted_in) {
    return <EmptyState icon="shield" title="Sin acceso a auditoría" hint="Este usuario no ha habilitado la visibilidad de su registro de auditoría en su configuración de privacidad." />;
  }
  const items = r.data.items || [];
  if (!items.length) return <EmptyState icon="audit" title="Sin actividad registrada" hint="Aún no hay eventos de auditoría para este usuario." />;
  return (
    <ul class="divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
      {items.map((e) => (
        <li key={e.id} class="flex items-center gap-3 py-2.5">
          <span class="w-7 h-7 rounded-md surface-subtle bordered flex items-center justify-center text-faint shrink-0"><Icon.audit size={14} /></span>
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-medium readout truncate">{e.action}</div>
          </div>
          <span class="text-[12px] text-faint shrink-0" title={fullTime(e.created_ms)}>{relTime(e.created_ms)}</span>
        </li>
      ))}
    </ul>
  );
}

