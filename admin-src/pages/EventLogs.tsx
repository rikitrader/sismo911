import { rbac } from '../api';
import { useResource } from '../hooks';
import { PageHeader, Avatar } from '../components/ui';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { ForbiddenInline, ErrorInline } from '../components/StateScreens';
import { relTime, fullTime } from '../util';

// Events come with varying shapes; pick the first present field defensively.
function pick(o: any, keys: string[], fallback = '—') {
  for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
  return fallback;
}
function ts(o: any): number | null {
  return o.ts ?? o.created_ms ?? o.at_ms ?? o.timestamp ?? null;
}

export function AuditPage() {
  const r = useResource(() => rbac.audit(150), []);
  const rows = (r.data?.events || []).map((e: any, i: number) => ({ id: e.id || String(i), ...e }));
  const columns: Column<any>[] = [
    { key: 'action', header: 'Acción', render: (e) => <span class="font-medium">{pick(e, ['action', 'event', 'type'])}</span> },
    { key: 'actor', header: 'Actor', width: '22%', render: (e) => <span class="text-muted truncate">{pick(e, ['actor', 'actor_email', 'user_email', 'by'])}</span> },
    { key: 'target', header: 'Objetivo', width: '24%', render: (e) => <span class="text-muted truncate">{pick(e, ['target', 'target_email', 'subject', 'detail', 'perm_key'])}</span> },
    { key: 'ts', header: 'Cuándo', width: '150px', align: 'right', render: (e) => <span class="text-faint" title={fullTime(ts(e))}>{relTime(ts(e))}</span> },
  ];
  return (
    <div class="animate-fade-in">
      <PageHeader title="Auditoría" subtitle="Registro inmutable de cambios" />
      {r.forbidden ? <ForbiddenInline /> : r.error ? <ErrorInline message={r.error} onRetry={r.reload} /> :
        <DataTable rows={rows} columns={columns} loading={r.loading} search searchKeys={['action', 'actor', 'target', 'event']} emptyTitle="Sin eventos de auditoría" emptyHint="Los cambios sobre usuarios, roles y permisos aparecerán aquí." />}
    </div>
  );
}

export function LoginHistoryPage() {
  const r = useResource(() => rbac.loginHistory(150), []);
  const rows = (r.data?.events || []).map((e: any, i: number) => ({ id: e.id || String(i), ...e }));
  const columns: Column<any>[] = [
    {
      key: 'user', header: 'Usuario', render: (e) => {
        const who = pick(e, ['email', 'user_email', 'username', 'name'], 'Desconocido');
        return <div class="flex items-center gap-3"><Avatar email={who} size={30} /><span class="font-medium truncate">{who}</span></div>;
      },
    },
    {
      key: 'result', header: 'Resultado', width: '130px', render: (e) => {
        const ok = e.success ?? e.ok ?? (e.result ? e.result === 'success' : undefined);
        if (ok === undefined) return <span class="text-faint">—</span>;
        return <span class={`pill ${ok ? 'bg-ok/12 text-ok' : 'bg-danger/12 text-danger'}`}><span class={`pill-dot ${ok ? 'bg-ok' : 'bg-danger'}`} />{ok ? 'Exitoso' : 'Fallido'}</span>;
      },
    },
    { key: 'ip', header: 'IP', width: '20%', render: (e) => <span class="text-muted font-mono text-[12px]">{pick(e, ['ip', 'ip_address'])}</span> },
    { key: 'ua', header: 'Dispositivo', width: '24%', render: (e) => <span class="text-faint truncate">{pick(e, ['user_agent', 'device', 'ua'])}</span> },
    { key: 'ts', header: 'Cuándo', width: '140px', align: 'right', render: (e) => <span class="text-faint" title={fullTime(ts(e))}>{relTime(ts(e))}</span> },
  ];
  return (
    <div class="animate-fade-in">
      <PageHeader title="Historial de acceso" subtitle="Inicios de sesión recientes" />
      {r.forbidden ? <ForbiddenInline /> : r.error ? <ErrorInline message={r.error} onRetry={r.reload} /> :
        <DataTable rows={rows} columns={columns} loading={r.loading} search searchKeys={['email', 'user_email', 'username', 'ip', 'ip_address']} emptyTitle="Sin historial de acceso" emptyHint="Los inicios de sesión aparecerán aquí." />}
    </div>
  );
}
