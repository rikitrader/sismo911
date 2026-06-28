import { useState, useEffect, useCallback } from 'preact/hooks';
import { NAV, NAV_TITLE } from './nav';
import { Icon } from './icons';
import { useRoute, navigate } from './router';
import { useTheme } from './theme';
import { ToastHost } from './toast';
import { CommandPalette } from './components/CommandPalette';
import type { QuickAction } from './components/CommandPalette';
import { SignInScreen } from './components/StateScreens';
import { DashboardPage } from './pages/Dashboard';
import { UsersPage } from './pages/Users';
import { RolesPage } from './pages/Roles';
import { PermissionsPage } from './pages/Permissions';
import { AuditPage, LoginHistoryPage, SessionsPage } from './pages/EventLogs';

const COLLAPSE_KEY = 'sismo-admin-nav-collapsed';

function PageRouter({ route }: { route: string }) {
  switch (route) {
    case 'users': return <UsersPage />;
    case 'roles': return <RolesPage />;
    case 'permissions': return <PermissionsPage />;
    case 'audit': return <AuditPage />;
    case 'login-history': return <LoginHistoryPage />;
    case 'sessions': return <SessionsPage />;
    case 'dashboard':
    default: return <DashboardPage />;
  }
}

export function App() {
  const route = useRoute();
  const [dark, toggleTheme] = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [unauth, setUnauth] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  const [mobileNav, setMobileNav] = useState(false);

  // Global 401 → sign-in screen (handles session expiry mid-session).
  useEffect(() => {
    const h = () => setUnauth(true);
    addEventListener('rbac-unauthorized', h);
    return () => removeEventListener('rbac-unauthorized', h);
  }, []);

  // Cmd/Ctrl-K to open palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((o) => !o); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => { setMobileNav(false); }, [route]);

  const toggleCollapse = useCallback(() => {
    setCollapsed((c) => { const n = !c; try { localStorage.setItem(COLLAPSE_KEY, n ? '1' : '0'); } catch {} return n; });
  }, []);

  const fireAction = (type: 'invite' | 'new-role', page: string) => {
    navigate(page);
    setTimeout(() => dispatchEvent(new CustomEvent(`rbac-action:${type}`)), 90);
  };
  const quickActions: QuickAction[] = [
    { id: 'invite', label: 'Invitar usuario', hint: 'Crear una invitación', icon: 'plus', run: () => fireAction('invite', 'users') },
    { id: 'new-role', label: 'Nuevo rol', hint: 'Crear un rol', icon: 'plus', run: () => fireAction('new-role', 'roles') },
  ];

  if (unauth) return <SignInScreen />;

  const active = NAV.find((n) => n.id === route)?.id || 'dashboard';

  return (
    <div class="flex h-full">
      {/* Mobile overlay */}
      {mobileNav && <div class="fixed inset-0 bg-black/40 z-30 lg:hidden" onClick={() => setMobileNav(false)} />}

      {/* Sidebar */}
      <aside class={`fixed lg:static z-40 h-full shrink-0 surface border-r flex flex-col transition-all duration-200 ${collapsed ? 'w-[68px]' : 'w-[252px]'} ${mobileNav ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div class={`flex items-center gap-2.5 h-14 px-4 border-b shrink-0 ${collapsed ? 'justify-center px-0' : ''}`}>
          <img src="/logo.svg" alt="" class="w-7 h-7 shrink-0" />
          {!collapsed && <div class="leading-tight min-w-0"><div class="font-semibold text-[13.5px] truncate">SISMO911</div><div class="label-caps !text-[9.5px]">Consola</div></div>}
        </div>

        <nav class="flex-1 overflow-y-auto py-3 px-2.5">
          {!collapsed && <div class="label-caps px-2.5 pb-2">{NAV_TITLE}</div>}
          <ul class="space-y-0.5">
            {NAV.map((n) => {
              const I = Icon[n.icon];
              const on = n.id === active;
              return (
                <li key={n.id}>
                  <a
                    href={`#/${n.id}`}
                    title={collapsed ? n.label : undefined}
                    aria-current={on ? 'page' : undefined}
                    class={`relative flex items-center gap-3 rounded-lg px-2.5 h-9 text-[13.5px] font-medium transition-colors focusable ${collapsed ? 'justify-center' : ''} ${on ? 'bg-[rgb(var(--bg-hover))] text-[rgb(var(--text))]' : 'text-muted hover:text-[rgb(var(--text))] hover:bg-[rgb(var(--bg-hover))]'}`}
                  >
                    {on && <span class="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full" style={{ background: 'rgb(var(--accent))' }} />}
                    <span class={on ? 'text-[rgb(var(--accent))]' : ''}><I size={18} /></span>
                    {!collapsed && <span class="truncate">{n.label}</span>}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        <div class="border-t p-2.5">
          <button class={`btn btn-ghost w-full ${collapsed ? 'px-0' : 'justify-start'}`} onClick={toggleCollapse} aria-label={collapsed ? 'Expandir menú' : 'Contraer menú'}>
            <span class={`transition-transform ${collapsed ? 'rotate-180' : ''}`}><Icon.collapse size={17} /></span>
            {!collapsed && <span class="text-[13px]">Contraer</span>}
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div class="flex-1 flex flex-col min-w-0 h-full">
        <header class="h-14 shrink-0 border-b surface/80 backdrop-blur flex items-center gap-2 px-4 sticky top-0 z-20" style={{ background: 'rgb(var(--bg-elev) / 0.85)' }}>
          <button class="btn btn-ghost btn-sm px-2 lg:hidden" aria-label="Menú" onClick={() => setMobileNav(true)}><Icon.more size={18} /></button>
          <button
            class="flex items-center gap-2 h-9 px-3 rounded-lg surface-subtle bordered text-faint hover:text-[rgb(var(--text))] transition-colors w-full max-w-xs focusable"
            onClick={() => setPaletteOpen(true)}
          >
            <Icon.search size={15} />
            <span class="text-[13px]">Buscar o ejecutar…</span>
            <kbd class="ml-auto text-[10.5px] font-medium surface bordered rounded px-1.5 py-0.5 flex items-center gap-0.5"><Icon.command size={11} />K</kbd>
          </button>
          <div class="ml-auto flex items-center gap-1">
            <button class="btn btn-ghost btn-sm px-2" aria-label={dark ? 'Modo claro' : 'Modo oscuro'} onClick={toggleTheme}>
              {dark ? <Icon.sun size={18} /> : <Icon.moon size={18} />}
            </button>
          </div>
        </header>

        <main class="flex-1 overflow-y-auto">
          <div class="max-w-[1180px] mx-auto px-5 sm:px-7 py-7">
            <PageRouter route={route} />
          </div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} actions={quickActions} />
      <ToastHost />
    </div>
  );
}
