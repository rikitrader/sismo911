import { useState, useEffect, useMemo } from 'preact/hooks';
import { rbac } from '../api';
import type { Org, Department, Team } from '../api';
import { useResource } from '../hooks';
import { PageHeader, EmptyState, Field, Spinner, Avatar } from '../components/ui';
import { ForbiddenInline, ErrorInline } from '../components/StateScreens';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/Confirm';
import { Icon } from '../icons';
import { toast } from '../toast';

async function run<T>(fn: () => Promise<T>, ok: string, after?: () => void): Promise<void> {
  try { await fn(); toast.success(ok); after?.(); }
  catch (e: any) { toast.error(e?.message || 'No se pudo completar la acción'); }
}

export function OrganizationPage() {
  const orgsRes = useResource(() => rbac.orgs(), []);
  const [orgId, setOrgId] = useState('');
  const [orgModal, setOrgModal] = useState<Org | null | 'new'>(null);

  const orgs = orgsRes.data?.orgs || [];
  useEffect(() => {
    if (!orgId && orgs.length) setOrgId(orgs[0].id);
  }, [orgs, orgId]);
  const activeOrg = orgs.find((o) => o.id === orgId);

  return (
    <div class="animate-fade-in">
      <PageHeader
        title="Organización"
        subtitle="Organizaciones, departamentos y equipos"
        actions={<button class="btn btn-primary" onClick={() => setOrgModal('new')}><Icon.plus size={16} /> Nueva organización</button>}
      />

      {orgsRes.forbidden ? <ForbiddenInline /> : orgsRes.error ? <ErrorInline message={orgsRes.error} onRetry={orgsRes.reload} /> : orgsRes.loading ? (
        <div class="space-y-3"><div class="skeleton h-9 w-64 rounded-lg" /><div class="skeleton h-48 rounded-xl" /></div>
      ) : orgs.length === 0 ? (
        <div class="card"><EmptyState title="Sin organizaciones" hint="Crea tu primera organización para definir departamentos y equipos." icon="org" action={<button class="btn btn-primary" onClick={() => setOrgModal('new')}><Icon.plus size={16} /> Nueva organización</button>} /></div>
      ) : (
        <>
          {/* Org switcher */}
          <div class="flex items-center gap-2 flex-wrap mb-6">
            {orgs.map((o) => (
              <button
                key={o.id}
                class={`btn btn-sm ${o.id === orgId ? 'btn-outline' : 'btn-ghost'}`}
                aria-pressed={o.id === orgId}
                onClick={() => setOrgId(o.id)}
              >
                <Icon.org size={14} /> {o.name}
              </button>
            ))}
            {activeOrg && (
              <button class="btn btn-ghost btn-sm px-2 text-faint" aria-label="Editar organización" onClick={() => setOrgModal(activeOrg)}><Icon.edit size={14} /></button>
            )}
          </div>

          {activeOrg && (
            <div class="grid lg:grid-cols-2 gap-6">
              <DepartmentsCard orgId={activeOrg.id} />
              <TeamsCard orgId={activeOrg.id} />
            </div>
          )}
        </>
      )}

      <OrgModal
        target={orgModal}
        onClose={() => setOrgModal(null)}
        onDone={(id) => { orgsRes.reload(); if (id) setOrgId(id); }}
      />
    </div>
  );
}

// ---------- Org create/edit ----------
function OrgModal({ target, onClose, onDone }: { target: Org | null | 'new'; onClose: () => void; onDone: (id?: string) => void }) {
  const editing = target && target !== 'new' ? target : null;
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (target) { setName(editing?.name || ''); setDesc(editing?.description || ''); }
  }, [target]);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      if (editing) { await rbac.updateOrg(editing.id, { name: name.trim(), description: desc.trim() }); toast.success('Organización actualizada'); onDone(); }
      else { const res = await rbac.createOrg({ name: name.trim(), description: desc.trim() }); toast.success('Organización creada'); onDone(res.id); }
      onClose();
    } catch (e: any) { toast.error(e?.message || 'No se pudo guardar'); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={!!target} onClose={onClose} title={editing ? 'Editar organización' : 'Nueva organización'}
      footer={<><button class="btn btn-ghost" onClick={onClose}>Cancelar</button><button class="btn btn-primary" disabled={busy || !name.trim()} onClick={submit}>{busy ? <Spinner /> : null} {editing ? 'Guardar' : 'Crear'}</button></>}>
      <div class="space-y-4">
        <Field label="Nombre"><input class="input" value={name} data-autofocus onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && submit()} /></Field>
        <Field label="Descripción (opcional)"><input class="input" value={desc} onInput={(e) => setDesc((e.target as HTMLInputElement).value)} /></Field>
      </div>
    </Modal>
  );
}

// ---------- Departments (tree by parent_id) ----------
interface DeptNode extends Department { children: DeptNode[] }
function buildTree(depts: Department[]): DeptNode[] {
  const map = new Map<string, DeptNode>();
  depts.forEach((d) => map.set(d.id, { ...d, children: [] }));
  const roots: DeptNode[] = [];
  map.forEach((node) => {
    const parent = node.parent_id ? map.get(node.parent_id) : null;
    if (parent) parent.children.push(node); else roots.push(node);
  });
  return roots;
}

function DepartmentsCard({ orgId }: { orgId: string }) {
  const r = useResource(() => rbac.departments(orgId), [orgId]);
  const [modal, setModal] = useState<{ dept?: Department; parentId?: string } | null>(null);
  const [del, setDel] = useState<Department | null>(null);

  const depts = r.data?.departments || [];
  const tree = useMemo(() => buildTree(depts), [depts]);

  return (
    <section class="card p-4">
      <div class="flex items-center justify-between mb-3">
        <h2 class="font-semibold text-[14px] flex items-center gap-2"><Icon.org size={16} /> Departamentos</h2>
        <button class="btn btn-ghost btn-sm" onClick={() => setModal({})}><Icon.plus size={14} /> Añadir</button>
      </div>

      {r.forbidden ? <ForbiddenInline /> : r.error ? <ErrorInline message={r.error} onRetry={r.reload} /> : r.loading ? (
        <div class="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} class="skeleton h-9 rounded-lg" />)}</div>
      ) : tree.length === 0 ? (
        <EmptyState title="Sin departamentos" hint="Crea una estructura organizativa." icon="org" />
      ) : (
        <ul class="space-y-0.5">
          {tree.map((n) => <DeptRow key={n.id} node={n} depth={0} onAddChild={(p) => setModal({ parentId: p })} onEdit={(d) => setModal({ dept: d })} onDelete={setDel} />)}
        </ul>
      )}

      {modal && (
        <DeptModal orgId={orgId} dept={modal.dept} parentId={modal.parentId} depts={depts} onClose={() => setModal(null)} onDone={r.reload} />
      )}
      <ConfirmDialog
        open={!!del} onClose={() => setDel(null)} danger title="Eliminar departamento" confirmLabel="Eliminar" successMsg="Departamento eliminado"
        body={<>Se eliminará <b>{del?.name}</b>. Los subdepartamentos quedarán sin asignar.</>}
        onConfirm={async () => { await rbac.deleteDepartment(del!.id); r.reload(); }}
      />
    </section>
  );
}

function DeptRow({ node, depth, onAddChild, onEdit, onDelete }: { node: DeptNode; depth: number; onAddChild: (parentId: string) => void; onEdit: (d: Department) => void; onDelete: (d: Department) => void }) {
  return (
    <>
      <li class="group flex items-center gap-2 rounded-lg px-2 h-9 row-hover" style={{ paddingLeft: `${8 + depth * 18}px` }}>
        <span class="text-faint shrink-0">{depth > 0 ? <Icon.chevron size={13} /> : <Icon.org size={14} />}</span>
        <span class="text-[13px] font-medium truncate flex-1">{node.name}</span>
        <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button class="btn btn-ghost btn-sm px-1.5 text-faint" aria-label="Añadir subdepartamento" onClick={() => onAddChild(node.id)}><Icon.plus size={13} /></button>
          <button class="btn btn-ghost btn-sm px-1.5 text-faint" aria-label="Editar" onClick={() => onEdit(node)}><Icon.edit size={13} /></button>
          <button class="btn btn-ghost btn-sm px-1.5 text-faint hover:text-danger" aria-label="Eliminar" onClick={() => onDelete(node)}><Icon.trash size={13} /></button>
        </div>
      </li>
      {node.children.map((c) => <DeptRow key={c.id} node={c} depth={depth + 1} onAddChild={onAddChild} onEdit={onEdit} onDelete={onDelete} />)}
    </>
  );
}

function DeptModal({ orgId, dept, parentId, depts, onClose, onDone }: { orgId: string; dept?: Department; parentId?: string; depts: Department[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(dept?.name || '');
  const [parent, setParent] = useState(dept?.parent_id || parentId || '');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    const body = { org_id: orgId, name: name.trim(), parent_id: parent || null };
    await run(
      () => dept ? rbac.updateDepartment(dept.id, body) : rbac.createDepartment(body),
      dept ? 'Departamento actualizado' : 'Departamento creado',
      () => { onDone(); onClose(); },
    );
    setBusy(false);
  }

  // Avoid choosing self/descendant as parent (simple self-exclusion).
  const options = depts.filter((d) => d.id !== dept?.id);
  return (
    <Modal open onClose={onClose} title={dept ? 'Editar departamento' : 'Nuevo departamento'}
      footer={<><button class="btn btn-ghost" onClick={onClose}>Cancelar</button><button class="btn btn-primary" disabled={busy || !name.trim()} onClick={submit}>{busy ? <Spinner /> : null} {dept ? 'Guardar' : 'Crear'}</button></>}>
      <div class="space-y-4">
        <Field label="Nombre"><input class="input" value={name} data-autofocus onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && submit()} /></Field>
        <Field label="Departamento padre (opcional)">
          <select class="input" value={parent} onChange={(e) => setParent((e.target as HTMLSelectElement).value)}>
            <option value="">— Nivel superior —</option>
            {options.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

// ---------- Teams ----------
function TeamsCard({ orgId }: { orgId: string }) {
  const r = useResource(() => rbac.teams(orgId), [orgId]);
  const [modal, setModal] = useState<Team | null | 'new'>(null);
  const [members, setMembers] = useState<Team | null>(null);
  const [del, setDel] = useState<Team | null>(null);

  const teams = r.data?.teams || [];

  return (
    <section class="card p-4">
      <div class="flex items-center justify-between mb-3">
        <h2 class="font-semibold text-[14px] flex items-center gap-2"><Icon.users size={16} /> Equipos</h2>
        <button class="btn btn-ghost btn-sm" onClick={() => setModal('new')}><Icon.plus size={14} /> Añadir</button>
      </div>

      {r.forbidden ? <ForbiddenInline /> : r.error ? <ErrorInline message={r.error} onRetry={r.reload} /> : r.loading ? (
        <div class="grid sm:grid-cols-2 gap-3">{Array.from({ length: 2 }).map((_, i) => <div key={i} class="skeleton h-28 rounded-xl" />)}</div>
      ) : teams.length === 0 ? (
        <EmptyState title="Sin equipos" hint="Agrupa personas en equipos dentro de esta organización." icon="users" />
      ) : (
        <div class="grid sm:grid-cols-2 gap-3">
          {teams.map((t) => (
            <div key={t.id} class="surface-subtle bordered rounded-xl p-3.5 flex flex-col">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <div class="text-[13.5px] font-semibold truncate">{t.name}</div>
                  {t.description && <div class="text-[11.5px] text-faint truncate">{t.description}</div>}
                </div>
                <button class="btn btn-ghost btn-sm px-1.5 text-faint" aria-label="Editar equipo" onClick={() => setModal(t)}><Icon.edit size={13} /></button>
              </div>
              <div class="flex items-center -space-x-2 mt-3 mb-3 min-h-[26px]">
                {(t.members || []).slice(0, 6).map((m) => (
                  <span key={m.user_id} title={m.name || m.email} class="ring-2 ring-[rgb(var(--bg-subtle))] rounded-full"><Avatar name={m.name} email={m.email} size={26} /></span>
                ))}
                {(t.members?.length || 0) > 6 && <span class="pill surface bordered text-faint ml-3">+{(t.members!.length) - 6}</span>}
                {!(t.members?.length) && <span class="text-[12px] text-faint">Sin miembros</span>}
              </div>
              <div class="flex gap-1 mt-auto">
                <button class="btn btn-ghost btn-sm flex-1" onClick={() => setMembers(t)}><Icon.users size={14} /> Miembros</button>
                <button class="btn btn-ghost btn-sm px-2 text-faint hover:text-danger" aria-label="Eliminar equipo" onClick={() => setDel(t)}><Icon.trash size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && <TeamModal orgId={orgId} team={modal === 'new' ? undefined : modal} onClose={() => setModal(null)} onDone={r.reload} />}
      {members && <MembersModal team={members} onClose={() => setMembers(null)} onDone={r.reload} />}
      <ConfirmDialog
        open={!!del} onClose={() => setDel(null)} danger title="Eliminar equipo" confirmLabel="Eliminar" successMsg="Equipo eliminado"
        body={<>Se eliminará el equipo <b>{del?.name}</b>.</>}
        onConfirm={async () => { await rbac.deleteTeam(del!.id); r.reload(); }}
      />
    </section>
  );
}

function TeamModal({ orgId, team, onClose, onDone }: { orgId: string; team?: Team; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(team?.name || '');
  const [desc, setDesc] = useState(team?.description || '');
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    const body = { org_id: orgId, name: name.trim(), description: desc.trim() };
    await run(
      () => team ? rbac.updateTeam(team.id, body) : rbac.createTeam(body),
      team ? 'Equipo actualizado' : 'Equipo creado',
      () => { onDone(); onClose(); },
    );
    setBusy(false);
  }
  return (
    <Modal open onClose={onClose} title={team ? 'Editar equipo' : 'Nuevo equipo'}
      footer={<><button class="btn btn-ghost" onClick={onClose}>Cancelar</button><button class="btn btn-primary" disabled={busy || !name.trim()} onClick={submit}>{busy ? <Spinner /> : null} {team ? 'Guardar' : 'Crear'}</button></>}>
      <div class="space-y-4">
        <Field label="Nombre"><input class="input" value={name} data-autofocus onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && submit()} /></Field>
        <Field label="Descripción (opcional)"><input class="input" value={desc} onInput={(e) => setDesc((e.target as HTMLInputElement).value)} /></Field>
      </div>
    </Modal>
  );
}

function MembersModal({ team, onClose, onDone }: { team: Team; onClose: () => void; onDone: () => void }) {
  const detail = useResource(() => rbac.teams(team.org_id), [team.org_id]);
  const usersRes = useResource(() => rbac.users('', ''), []);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);

  // Re-derive the freshest member list for this team from the org teams list.
  const fresh = (detail.data?.teams || []).find((t) => t.id === team.id) || team;
  const members = fresh.members || [];
  const memberIds = new Set(members.map((m) => m.user_id));
  const candidates = (usersRes.data?.users || []).filter((u) => !memberIds.has(u.id));

  async function add() {
    if (!pick) return;
    setBusy(true);
    await run(() => rbac.addTeamMember(team.id, pick), 'Miembro añadido', () => { detail.reload(); onDone(); setPick(''); });
    setBusy(false);
  }
  async function remove(userId: string) {
    setBusy(true);
    await run(() => rbac.removeTeamMember(team.id, userId), 'Miembro removido', () => { detail.reload(); onDone(); });
    setBusy(false);
  }

  return (
    <Modal open onClose={onClose} width={480} title={`Miembros · ${team.name}`}>
      <div class="space-y-4">
        <div>
          <div class="label-caps mb-2">Miembros · {members.length}</div>
          {detail.loading ? (
            <div class="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} class="skeleton h-11 rounded-lg" />)}</div>
          ) : members.length ? (
            <ul class="space-y-1.5 max-h-60 overflow-y-auto">
              {members.map((m) => (
                <li key={m.user_id} class="flex items-center gap-2.5 surface-subtle bordered rounded-lg px-2.5 py-2">
                  <Avatar name={m.name} email={m.email} size={28} />
                  <div class="min-w-0 flex-1"><div class="text-[13px] font-medium truncate">{m.name || m.email || m.user_id}</div>{m.email && m.name && <div class="text-[11px] text-faint truncate">{m.email}</div>}</div>
                  <button class="btn btn-ghost btn-sm px-2 text-faint hover:text-danger" disabled={busy} aria-label="Quitar miembro" onClick={() => remove(m.user_id)}><Icon.close size={14} /></button>
                </li>
              ))}
            </ul>
          ) : <p class="text-faint text-[13px]">Este equipo no tiene miembros.</p>}
        </div>
        <div>
          <div class="label-caps mb-2">Añadir miembro</div>
          <div class="flex gap-2">
            <select class="input flex-1" value={pick} onChange={(e) => setPick((e.target as HTMLSelectElement).value)} aria-label="Seleccionar usuario">
              <option value="">Seleccionar usuario…</option>
              {candidates.map((u) => <option key={u.id} value={u.id}>{u.name || u.preferred_name || u.email}</option>)}
            </select>
            <button class="btn btn-primary" disabled={!pick || busy} onClick={add}>{busy ? <Spinner /> : <Icon.plus size={16} />}</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
