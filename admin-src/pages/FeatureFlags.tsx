import { useState, useMemo } from 'preact/hooks';
import { rbac } from '../api';
import type { FeatureFlag, FlagScope, FeatureFlagOverrideRow, UserRow } from '../api';
import { useResource } from '../hooks';
import { PageHeader, EmptyState, Field, Spinner, Avatar } from '../components/ui';
import { ForbiddenInline, ErrorInline } from '../components/StateScreens';
import { Modal } from '../components/Modal';
import { Icon } from '../icons';
import { toast } from '../toast';

function Toggle({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange: () => void; label: string }) {
  return (
    <button
      role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onChange}
      class={`relative inline-flex h-[22px] w-[38px] items-center rounded-full transition-colors shrink-0 focusable ${on ? 'bg-[rgb(var(--accent))]' : 'surface-subtle bordered'} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <span class={`inline-block h-[16px] w-[16px] rounded-full bg-white shadow transition-transform ${on ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
    </button>
  );
}

const SCOPE_LABEL: Record<FlagScope, string> = { global: 'Global', org: 'Organización', role: 'Rol', user: 'Usuario' };

export function FeatureFlagsPage() {
  const r = useResource(() => rbac.featureFlags(), []);
  const [busyKey, setBusyKey] = useState('');
  const [overrideFor, setOverrideFor] = useState<FeatureFlag | null>(null);
  const [lookup, setLookup] = useState(false);

  const flags = r.data?.flags || [];
  const groups = useMemo(() => {
    const m = new Map<string, FeatureFlag[]>();
    for (const f of flags) {
      const g = f.module || 'General';
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(f);
    }
    return Array.from(m.entries());
  }, [flags]);

  async function toggleGlobal(f: FeatureFlag) {
    setBusyKey(f.module_key);
    try {
      await rbac.setFeatureFlag({ module_key: f.module_key, scope_type: 'global', scope_id: 'global', enabled: !f.default_enabled });
      toast.success('Flag actualizado'); r.reload();
    } catch (e: any) { toast.error(e?.message || 'No se pudo actualizar'); }
    finally { setBusyKey(''); }
  }

  return (
    <div class="animate-fade-in">
      <PageHeader
        title="Feature Flags"
        subtitle="Activa o desactiva módulos por organización, rol o usuario"
        actions={<button class="btn btn-outline" onClick={() => setLookup(true)}><Icon.search size={15} /> Efectivo para usuario</button>}
      />

      {r.forbidden ? <ForbiddenInline /> : r.error ? <ErrorInline message={r.error} onRetry={r.reload} /> : r.loading ? (
        <div class="space-y-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} class="skeleton h-16 rounded-xl" />)}</div>
      ) : flags.length === 0 ? (
        <div class="card"><EmptyState title="Sin feature flags" hint="Los módulos configurables aparecerán aquí." icon="flag" /></div>
      ) : (
        <div class="space-y-7">
          {groups.map(([group, items]) => (
            <section key={group}>
              <div class="label-caps mb-2.5">{group}</div>
              <div class="card divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
                {items.map((f) => (
                  <div key={f.module_key} class="px-4 py-3.5">
                    <div class="flex items-center gap-3">
                      <span class="w-9 h-9 rounded-lg surface-subtle bordered flex items-center justify-center text-faint shrink-0"><Icon.plug size={17} /></span>
                      <div class="min-w-0 flex-1">
                        <div class="text-[13.5px] font-medium truncate">{f.label || f.module_key}</div>
                        <div class="text-[11.5px] text-faint font-mono truncate">{f.module_key}</div>
                      </div>
                      <button class="btn btn-ghost btn-sm" onClick={() => setOverrideFor(f)}>
                        <Icon.plus size={13} /> Override{f.overrides?.length ? ` · ${f.overrides.length}` : ''}
                      </button>
                      {busyKey === f.module_key ? <Spinner /> : <Toggle on={!!f.default_enabled} label={`Activar ${f.label || f.module_key}`} onChange={() => toggleGlobal(f)} />}
                    </div>
                    {f.description && <p class="text-[12px] text-faint mt-1.5 ml-12">{f.description}</p>}
                    {!!f.overrides?.length && (
                      <div class="flex flex-wrap gap-1.5 mt-2.5 ml-12">
                        {f.overrides.map((o) => (
                          <OverridePill key={`${o.scope_type}:${o.scope_id}`} flag={f} ov={o} onChanged={r.reload} />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {overrideFor && <OverrideModal flag={overrideFor} onClose={() => setOverrideFor(null)} onDone={r.reload} />}
      {lookup && <EffectiveModal onClose={() => setLookup(false)} />}
    </div>
  );
}

function OverridePill({ flag, ov, onChanged }: { flag: FeatureFlag; ov: FeatureFlagOverrideRow; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    try { await rbac.removeFeatureFlag(flag.module_key, ov.scope_type, ov.scope_id); toast.success('Override eliminado'); onChanged(); }
    catch (e: any) { toast.error(e?.message || 'No se pudo eliminar'); }
    finally { setBusy(false); }
  }
  return (
    <span class={`pill bordered ${ov.enabled ? 'bg-ok/12 text-ok' : 'bg-danger/12 text-danger'}`}>
      <span class={`pill-dot ${ov.enabled ? 'bg-ok' : 'bg-danger'}`} />
      {SCOPE_LABEL[ov.scope_type]}: {ov.scope_label || ov.scope_id} · {ov.enabled ? 'on' : 'off'}
      <button class="ml-1 -mr-1 hover:opacity-70" disabled={busy} aria-label="Quitar override" onClick={remove}><Icon.close size={12} /></button>
    </span>
  );
}

// Add/replace an override for a given scope.
function OverrideModal({ flag, onClose, onDone }: { flag: FeatureFlag; onClose: () => void; onDone: () => void }) {
  const [scopeType, setScopeType] = useState<FlagScope>('org');
  const [scopeId, setScopeId] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  const orgsRes = useResource(() => rbac.orgs(), []);
  const rolesRes = useResource(() => rbac.roles(), []);
  const usersRes = useResource(() => rbac.users('', ''), []);

  const options: { id: string; label: string }[] =
    scopeType === 'org' ? (orgsRes.data?.orgs || []).map((o) => ({ id: o.id, label: o.name }))
    : scopeType === 'role' ? (rolesRes.data?.roles || []).map((x) => ({ id: x.key, label: x.name }))
    : (usersRes.data?.users || []).map((u) => ({ id: u.id, label: u.name || u.preferred_name || u.email }));

  async function submit() {
    if (!scopeId) return;
    setBusy(true);
    try {
      await rbac.setFeatureFlag({ module_key: flag.module_key, scope_type: scopeType, scope_id: scopeId, enabled });
      toast.success('Override guardado'); onDone(); onClose();
    } catch (e: any) { toast.error(e?.message || 'No se pudo guardar'); }
    finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={`Override · ${flag.label || flag.module_key}`}
      footer={<><button class="btn btn-ghost" onClick={onClose}>Cancelar</button><button class="btn btn-primary" disabled={busy || !scopeId} onClick={submit}>{busy ? <Spinner /> : null} Guardar</button></>}>
      <div class="space-y-4">
        <Field label="Ámbito">
          <div class="flex gap-1">
            {(['org', 'role', 'user'] as FlagScope[]).map((s) => (
              <button key={s} class={`btn btn-sm flex-1 ${scopeType === s ? 'btn-outline' : 'btn-ghost'}`} aria-pressed={scopeType === s} onClick={() => { setScopeType(s); setScopeId(''); }}>{SCOPE_LABEL[s]}</button>
            ))}
          </div>
        </Field>
        <Field label={SCOPE_LABEL[scopeType]}>
          <select class="input" value={scopeId} onChange={(e) => setScopeId((e.target as HTMLSelectElement).value)}>
            <option value="">Seleccionar…</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </Field>
        <div class="flex items-center justify-between surface-subtle bordered rounded-lg px-3.5 py-2.5">
          <span class="text-[13px] font-medium">{enabled ? 'Activado' : 'Desactivado'} para este ámbito</span>
          <Toggle on={enabled} label="Activar override" onChange={() => setEnabled((v) => !v)} />
        </div>
      </div>
    </Modal>
  );
}

// "Effective for user" lookup.
function EffectiveModal({ onClose }: { onClose: () => void }) {
  const usersRes = useResource(() => rbac.users('', ''), []);
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ module_key: string; label?: string; enabled: boolean; source?: string }[] | null>(null);

  async function lookup(id: string) {
    setUserId(id);
    setResult(null);
    if (!id) return;
    setBusy(true);
    try { const res = await rbac.featureFlagsEffective(id); setResult(res.effective || []); }
    catch (e: any) { toast.error(e?.message || 'No se pudo consultar'); }
    finally { setBusy(false); }
  }

  const users: UserRow[] = usersRes.data?.users || [];
  const sel = users.find((u) => u.id === userId);

  return (
    <Modal open onClose={onClose} width={500} title="Flags efectivos para usuario">
      <div class="space-y-4">
        <Field label="Usuario">
          <select class="input" value={userId} onChange={(e) => lookup((e.target as HTMLSelectElement).value)}>
            <option value="">Seleccionar usuario…</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name || u.preferred_name || u.email}</option>)}
          </select>
        </Field>
        {sel && <div class="flex items-center gap-2.5"><Avatar name={sel.name} email={sel.email} size={30} /><div class="min-w-0"><div class="text-[13px] font-medium truncate">{sel.name || sel.email}</div><div class="text-[11.5px] text-faint truncate">{sel.email}</div></div></div>}
        {busy ? (
          <div class="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} class="skeleton h-10 rounded-lg" />)}</div>
        ) : result ? (
          result.length ? (
            <ul class="space-y-1.5 max-h-72 overflow-y-auto">
              {result.map((f) => (
                <li key={f.module_key} class="flex items-center gap-3 surface-subtle bordered rounded-lg px-3 py-2">
                  <div class="min-w-0 flex-1">
                    <div class="text-[13px] font-medium truncate">{f.label || f.module_key}</div>
                    {f.source && <div class="text-[11px] text-faint truncate">vía {f.source}</div>}
                  </div>
                  <span class={`pill ${f.enabled ? 'bg-ok/12 text-ok' : 'bg-danger/12 text-danger'}`}><span class={`pill-dot ${f.enabled ? 'bg-ok' : 'bg-danger'}`} />{f.enabled ? 'Activo' : 'Inactivo'}</span>
                </li>
              ))}
            </ul>
          ) : <EmptyState title="Sin flags efectivos" icon="flag" />
        ) : <p class="text-faint text-[13px] text-center py-4">Selecciona un usuario para ver sus flags efectivos.</p>}
      </div>
    </Modal>
  );
}
