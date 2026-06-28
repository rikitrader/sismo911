import { useEffect, useMemo, useState } from 'preact/hooks';
import { rbac } from '../api';
import type { Role, Permission } from '../api';
import { useResource } from '../hooks';
import { PageHeader, Spinner, Field, EmptyState } from '../components/ui';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { Drawer } from '../components/Drawer';
import { ForbiddenInline, ErrorInline } from '../components/StateScreens';
import { Icon } from '../icons';
import { toast } from '../toast';

type Editing = { role: Role | null } | null; // null=closed, role:null=new

export function RolesPage() {
  const r = useResource(() => rbac.roles(), []);
  const perms = useResource(() => rbac.permissions(), []);
  const [editing, setEditing] = useState<Editing>(null);

  useEffect(() => {
    const h = () => setEditing({ role: null });
    addEventListener('rbac-action:new-role', h);
    return () => removeEventListener('rbac-action:new-role', h);
  }, []);

  const columns: Column<Role>[] = [
    {
      key: 'role', header: 'Rol', render: (x) => (
        <div class="flex items-center gap-3">
          <span class="w-8 h-8 rounded-md surface-subtle bordered flex items-center justify-center text-faint shrink-0"><Icon.roles size={16} /></span>
          <div class="min-w-0">
            <div class="font-medium truncate flex items-center gap-2">{x.name}{x.is_system && <span class="pill surface-subtle bordered text-faint">sistema</span>}</div>
            <div class="text-[11.5px] text-faint font-mono truncate">{x.key}</div>
          </div>
        </div>
      ),
    },
    { key: 'desc', header: 'Descripción', width: '32%', render: (x) => <span class="text-muted line-clamp-1">{x.description || '—'}</span> },
    { key: 'inherits', header: 'Hereda', width: '18%', render: (x) => x.inherits?.length ? <div class="flex flex-wrap gap-1">{x.inherits.map((k) => <span key={k} class="pill surface-subtle bordered text-muted font-mono text-[11px]">{k}</span>)}</div> : <span class="text-faint">—</span> },
    { key: 'perms', header: 'Permisos', width: '110px', align: 'right', render: (x) => <span class="text-faint tabular-nums">{x.perms?.length || 0}</span> },
  ];

  return (
    <div class="animate-fade-in">
      <PageHeader title="Roles" subtitle="Define roles, herencia y permisos"
        actions={<button class="btn btn-primary" onClick={() => setEditing({ role: null })}><Icon.plus size={16} /> Nuevo rol</button>} />
      {r.forbidden ? <ForbiddenInline /> : r.error ? <ErrorInline message={r.error} onRetry={r.reload} /> : (
        <DataTable rows={r.data?.roles || []} columns={columns} loading={r.loading} search searchKeys={['name', 'key', 'description']}
          onRowClick={(x) => setEditing({ role: x })} emptyTitle="No hay roles" emptyHint="Crea el primer rol para organizar permisos." />
      )}
      {editing && (
        <RoleEditor
          role={editing.role}
          allRoles={r.data?.roles || []}
          categories={perms.data?.categories || {}}
          loadingPerms={perms.loading}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); r.reload(); }}
        />
      )}
    </div>
  );
}

function RoleEditor({ role, allRoles, categories, loadingPerms, onClose, onSaved }: {
  role: Role | null; allRoles: Role[]; categories: Record<string, Permission[]>; loadingPerms: boolean; onClose: () => void; onSaved: () => void;
}) {
  const isNew = !role;
  const [key, setKey] = useState(role?.key || '');
  const [name, setName] = useState(role?.name || '');
  const [description, setDescription] = useState(role?.description || '');
  const [inherits, setInherits] = useState<string[]>(role?.inherits || []);
  const [perms, setPerms] = useState<Set<string>>(new Set(role?.perms || []));
  const [busy, setBusy] = useState(false);
  const locked = !!role?.is_system;

  const totalPerms = useMemo(() => Object.values(categories).reduce((a, b) => a + b.length, 0), [categories]);
  const inheritOptions = allRoles.filter((x) => x.key !== role?.key);

  function togglePerm(k: string) {
    if (locked) return;
    setPerms((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }
  function toggleCat(list: Permission[]) {
    if (locked) return;
    const keys = list.map((p) => p.key);
    const allOn = keys.every((k) => perms.has(k));
    setPerms((prev) => { const n = new Set(prev); keys.forEach((k) => allOn ? n.delete(k) : n.add(k)); return n; });
  }

  async function save() {
    if (!name.trim() || (isNew && !key.trim())) { toast.error('Nombre y clave son obligatorios'); return; }
    setBusy(true);
    const payload = { name: name.trim(), description: description.trim(), inherits, perms: [...perms] };
    try {
      if (isNew) await rbac.createRole({ key: key.trim(), ...payload });
      else await rbac.updateRole(role!.id, payload);
      toast.success(isNew ? 'Rol creado' : 'Rol actualizado');
      onSaved();
    } catch (e: any) { toast.error(e?.message || 'No se pudo guardar el rol'); }
    finally { setBusy(false); }
  }

  return (
    <Drawer open onClose={onClose} width={560}
      title={isNew ? 'Nuevo rol' : role!.name}
      subtitle={locked ? 'Rol de sistema (solo lectura)' : `${perms.size} de ${totalPerms} permisos`}
      footer={<div class="flex justify-end gap-2"><button class="btn btn-ghost" onClick={onClose}>Cancelar</button><button class="btn btn-primary" disabled={busy || locked} onClick={save}>{busy ? <Spinner /> : <Icon.check size={16} />} {isNew ? 'Crear rol' : 'Guardar cambios'}</button></div>}>
      <div class="p-5 space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <Field label="Clave" hint={isNew ? 'minúsculas, ej. ops_manager' : undefined}>
            <input class="input font-mono" value={key} disabled={!isNew} placeholder="role_key" onInput={(e) => setKey((e.target as HTMLInputElement).value.toLowerCase().replace(/\s+/g, '_'))} />
          </Field>
          <Field label="Nombre">
            <input class="input" data-autofocus value={name} disabled={locked} placeholder="Gestor de operaciones" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </Field>
        </div>
        <Field label="Descripción">
          <textarea class="input" rows={2} value={description} disabled={locked} placeholder="¿Qué puede hacer este rol?" onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)} />
        </Field>
        <Field label="Hereda de">
          {inheritOptions.length ? (
            <div class="flex flex-wrap gap-1.5">
              {inheritOptions.map((x) => {
                const on = inherits.includes(x.key);
                return (
                  <button key={x.key} disabled={locked} aria-pressed={on}
                    class={`pill border transition-colors ${on ? 'bg-brand-500/15 text-[rgb(var(--accent))] border-brand-500/30' : 'surface-subtle bordered text-muted hover:text-[rgb(var(--text))]'}`}
                    onClick={() => setInherits((p) => on ? p.filter((k) => k !== x.key) : [...p, x.key])}>
                    {on && <Icon.check size={12} />}{x.name}
                  </button>
                );
              })}
            </div>
          ) : <p class="text-faint text-[13px]">No hay otros roles.</p>}
        </Field>

        <div>
          <div class="label-caps mb-2">Matriz de permisos</div>
          {loadingPerms ? <div class="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} class="skeleton h-10 rounded-lg" />)}</div>
            : Object.keys(categories).length === 0 ? <EmptyState title="Sin permisos disponibles" icon="permissions" />
            : (
              <div class="space-y-4">
                {Object.entries(categories).map(([cat, list]) => {
                  const allOn = list.every((p) => perms.has(p.key));
                  const someOn = list.some((p) => perms.has(p.key));
                  return (
                    <div key={cat} class="surface-subtle bordered rounded-lg overflow-hidden">
                      <button class="w-full flex items-center justify-between px-3 py-2 surface border-b text-left" disabled={locked} onClick={() => toggleCat(list)}>
                        <span class="text-[12.5px] font-semibold">{cat}</span>
                        <span class={`pill ${allOn ? 'bg-ok/12 text-ok' : someOn ? 'bg-warn/15 text-warn' : 'text-faint'}`}>{list.filter((p) => perms.has(p.key)).length}/{list.length}</span>
                      </button>
                      <div class="grid sm:grid-cols-2 gap-px">
                        {list.map((p) => {
                          const on = perms.has(p.key);
                          return (
                            <label key={p.key} class={`flex items-center gap-2.5 px-3 py-2 surface cursor-pointer select-none row-hover ${locked ? 'opacity-70 cursor-default' : ''}`}>
                              <span class={`w-[18px] h-[18px] rounded-[5px] border flex items-center justify-center shrink-0 transition-colors ${on ? 'bg-[rgb(var(--accent))] border-transparent text-[rgb(var(--accent-fg))]' : 'border-[rgb(var(--border-strong))]'}`}>{on && <Icon.check size={13} />}</span>
                              <input type="checkbox" class="sr-only" checked={on} disabled={locked} onChange={() => togglePerm(p.key)} />
                              <span class="min-w-0"><span class="block text-[12.5px] truncate">{p.label}</span><span class="block text-[10.5px] text-faint font-mono truncate">{p.key}</span></span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
        </div>
      </div>
    </Drawer>
  );
}
