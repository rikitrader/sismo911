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
  { id: 'invitations', label: 'Invitaciones', icon: 'mail', desc: 'Invitar usuarios por correo, SMS o QR' },
  { id: 'approvals', label: 'Aprobaciones', icon: 'userCheck', desc: 'Aprobar o rechazar usuarios pendientes' },
  { id: 'roles', label: 'Roles', icon: 'roles', desc: 'Roles y herencia de permisos' },
  { id: 'permissions', label: 'Permisos', icon: 'permissions', desc: 'Catálogo de permisos' },
  { id: 'organization', label: 'Organización', icon: 'org', desc: 'Organizaciones, departamentos y equipos' },
  { id: 'feature-flags', label: 'Feature Flags', icon: 'flag', desc: 'Activar o desactivar módulos por ámbito' },
  { id: 'audit', label: 'Auditoría', icon: 'audit', desc: 'Registro de auditoría' },
  { id: 'login-history', label: 'Historial de acceso', icon: 'login', desc: 'Inicios de sesión recientes' },
  { id: 'sessions', label: 'Sesiones', icon: 'sessions', desc: 'Sesiones activas y revocación' },
  { id: 'security', label: 'Seguridad', icon: 'shield', desc: 'Autenticación de dos factores (MFA)' },
];

export const NAV_TITLE = 'ADMINISTRATION';
