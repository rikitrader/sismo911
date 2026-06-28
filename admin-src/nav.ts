// Navigation is data-driven so new sections drop in with one line.
import type { IconName } from './icons';

export interface NavItem {
  id: string;       // route slug (hash)
  label: string;
  icon: IconName;
  desc: string;     // for the command palette
}

export const NAV: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', desc: 'Resumen general y métricas' },
  { id: 'users', label: 'Usuarios', icon: 'users', desc: 'Gestionar usuarios y accesos' },
  { id: 'roles', label: 'Roles', icon: 'roles', desc: 'Roles y herencia de permisos' },
  { id: 'permissions', label: 'Permisos', icon: 'permissions', desc: 'Catálogo de permisos' },
  { id: 'audit', label: 'Auditoría', icon: 'audit', desc: 'Registro de auditoría' },
  { id: 'login-history', label: 'Historial de acceso', icon: 'login', desc: 'Inicios de sesión recientes' },
  { id: 'sessions', label: 'Sesiones', icon: 'sessions', desc: 'Sesiones activas' },
];

export const NAV_TITLE = 'ADMINISTRATION';
