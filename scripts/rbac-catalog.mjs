// ============================================================================
// rbac-catalog.mjs — CANONICAL source of truth for the RBAC permission catalog,
// system roles, modules (feature flags) and default field policies.
//
// gen-rbac-seed.mjs reads this to emit migrations/0047_rbac_seed.sql. The Worker
// runtime reads the *resulting rows* from D1 (rbac_permissions / rbac_roles / …)
// — it never imports this file — so there is exactly one source of truth and no
// TS/JSON-import coupling. New module ⇒ add rows here, regenerate, ship. No
// schema change, no redesign (the final objective: extensible).
// ============================================================================

// ── Modules (drive feature_flags; a disabled module 404s its routes) ─────────
export const MODULES = [
  'users', 'teams', 'departments', 'organizations', 'roles', 'permissions',
  'feature_flags', 'locations', 'api_keys', 'audit', 'security', 'sessions',
  'notifications', 'billing', 'integrations',
  'patients', 'cases', 'incidents', 'hospitals', 'volunteers', 'resources',
  'vehicles', 'shelters', 'donations', 'telemedicina', 'missing_persons',
  'familia', 'earthquake', 'flood', 'fire', 'hurricane', 'weather',
  'reports', 'analytics', 'flota', 'suministros', 'ai', 'monitoring',
];

// ── Permission catalog: resource → [actions], with UI category + labels ──────
// Keys are `resource:action`. Labels are human-facing (UI permission matrix).
const RESOURCES = {
  // Administration
  users:         { cat: 'Administration', actions: ['read','create','update','suspend','invite','reset_password','export','import','delete','impersonate'] },
  roles:         { cat: 'Administration', actions: ['read','create','update','delete','assign'] },
  permissions:   { cat: 'Administration', actions: ['read','grant'] },
  teams:         { cat: 'Administration', actions: ['read','manage'] },
  departments:   { cat: 'Administration', actions: ['read','manage'] },
  organizations: { cat: 'Administration', actions: ['read','manage'] },
  feature_flags: { cat: 'Administration', actions: ['read','manage'] },
  locations:     { cat: 'Administration', actions: ['read','manage'] },
  api_keys:      { cat: 'Administration', actions: ['read','manage'] },
  audit:         { cat: 'Security',       actions: ['read','export'] },
  security:      { cat: 'Security',       actions: ['read'] },
  sessions:      { cat: 'Security',       actions: ['read','revoke'] },
  login_history: { cat: 'Security',       actions: ['read'] },
  notifications: { cat: 'Administration', actions: ['read','manage'] },
  billing:       { cat: 'Administration', actions: ['read','manage'] },
  integrations:  { cat: 'Administration', actions: ['read','manage'] },
  // Emergency / domain modules
  patients:      { cat: 'Medical',        actions: ['read','create','update','delete','medical_notes','archive'] },
  cases:         { cat: 'Operations',     actions: ['read','create','update','delete','approve','reject','assign'] },
  incidents:     { cat: 'Operations',     actions: ['read','create','update','delete','gps'] },
  hospitals:     { cat: 'Medical',        actions: ['read','manage'] },
  volunteers:    { cat: 'Operations',     actions: ['read','manage'] },
  resources:     { cat: 'Logistics',      actions: ['read','manage'] },
  vehicles:      { cat: 'Logistics',      actions: ['read','manage'] },
  shelters:      { cat: 'Operations',     actions: ['read','manage'] },
  donations:     { cat: 'Finance',        actions: ['read','manage'] },
  telemedicina:  { cat: 'Medical',        actions: ['read','manage','consult'] },
  missing_persons:{ cat: 'Operations',    actions: ['read','create','update','delete'] },
  familia:       { cat: 'Operations',     actions: ['read','moderate'] },
  flota:         { cat: 'Operations',     actions: ['read','dispatch','track','manage'] },
  suministros:   { cat: 'Logistics',      actions: ['read','manage'] },
  reports:       { cat: 'Operations',     actions: ['read','export','moderate'] },
  analytics:     { cat: 'Operations',     actions: ['read'] },
  settings:      { cat: 'System',         actions: ['read','manage'] },
  system:        { cat: 'System',         actions: ['read','manage'] },
  database:      { cat: 'System',         actions: ['read','manage'] },
  ai:            { cat: 'System',         actions: ['use','manage'] },
  monitoring:    { cat: 'System',         actions: ['read'] },
  // DEPRECATED (Phase 2 R1): the coarse "operational console" capability. No route
  // maps to it anymore — evaluateGate() now uses the fine-grained per-surface
  // permissions below. Kept as a catalog row for back-compat; do not map new
  // surfaces to it.
  ops:           { cat: 'Administration', actions: ['console'] },
  // Fine-grained per-surface permissions (Phase 2 R1) that REPLACE ops:console in
  // the global gate. Each legacy operational surface maps to exactly one of these,
  // and all are granted to the legacy `operator` role below so access is preserved
  // 1:1 (super_admin holds everything via god-mode).
  admin:         { cat: 'Operations', actions: ['maintenance'] },   // /api/admin data-maintenance jobs
  contacts:      { cat: 'Operations', actions: ['manage'] },        // /api/contacts
  acopio:        { cat: 'Logistics',  actions: ['manage'] },        // /api/acopio
  aid_orgs:      { cat: 'Operations', actions: ['manage'] },        // /api/aid-orgs
  emergencia:    { cat: 'Operations', actions: ['manage'] },        // /api/emergencia
  damage:        { cat: 'Operations', actions: ['moderate'] },      // /api/danos-estructurales, /api/damage
  persons:       { cat: 'Operations', actions: ['moderate'] },      // /api/persons moderation + case docket
  sos:           { cat: 'Operations', actions: ['triage'] },        // /api/sos triage
  events:        { cat: 'Operations', actions: ['refresh'] },       // /api/events/refresh + backfill
  sat:           { cat: 'Operations', actions: ['analyze'] },       // /api/sat analyze/verify
};

const titleCase = (s) => s.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

export const PERMISSIONS = Object.entries(RESOURCES).flatMap(([resource, def]) =>
  def.actions.map((action) => ({
    key: `${resource}:${action}`,
    resource,
    action,
    label: `${titleCase(action)} ${titleCase(resource)}`,
    category: def.cat,
  }))
);

const ALL_KEYS = PERMISSIONS.map((p) => p.key);
const allOf = (...resources) => ALL_KEYS.filter((k) => resources.includes(k.split(':')[0]));
const readOf = (...resources) => resources.map((r) => `${r}:read`);

// ── System roles. `perms: '*'` = every permission. `inherits` = role keys whose
// grants are absorbed transitively at resolution time. Legacy users.role values
// (admin/operator/citizen) map to super_admin/operator/citizen so the live gates
// keep behaving identically. ──────────────────────────────────────────────────
export const ROLES = [
  { key: 'super_admin',  name: 'Super Administrator', perms: '*', desc: 'Full, unrestricted access to every module and action.' },
  { key: 'owner',        name: 'Owner', inherits: ['super_admin'], desc: 'Organization owner.' },
  { key: 'operations_director', name: 'Operations Director',
    inherits: ['emergency_manager'],
    perms: [...allOf('users','teams','departments','reports','analytics'), 'feature_flags:read'],
    desc: 'Runs operations; manages staff, teams and reporting.' },
  { key: 'emergency_manager', name: 'Emergency Manager',
    inherits: ['dispatcher'],
    perms: [...allOf('cases','incidents','shelters','resources','volunteers','flota','suministros'), 'analytics:read','reports:read','reports:export'],
    desc: 'Coordinates incident response across modules.' },
  { key: 'dispatcher',   name: 'Dispatcher',
    perms: [...readOf('incidents','cases','shelters','resources','volunteers'), 'flota:read','flota:dispatch','flota:track','incidents:create','incidents:update','cases:assign'],
    desc: 'Dispatches units and assigns cases.' },
  { key: 'incident_commander', name: 'Incident Commander',
    inherits: ['dispatcher'],
    perms: ['incidents:gps','cases:approve','cases:reject','resources:manage'],
    desc: 'On-scene command authority.' },
  { key: 'medical_director', name: 'Medical Director',
    inherits: ['doctor'],
    perms: ['hospitals:manage','telemedicina:manage','patients:delete'],
    desc: 'Oversees medical operations and telemedicine.' },
  { key: 'doctor',       name: 'Doctor',
    perms: ['patients:read','patients:create','patients:update','patients:medical_notes','telemedicina:read','telemedicina:consult','hospitals:read'],
    desc: 'Treats patients; full medical-notes access.' },
  { key: 'nurse',        name: 'Nurse',
    perms: ['patients:read','patients:update','patients:medical_notes','telemedicina:read','hospitals:read'],
    desc: 'Patient care; medical-notes access.' },
  { key: 'paramedic',    name: 'Paramedic',
    perms: ['patients:read','patients:create','incidents:read','incidents:gps','flota:track'],
    desc: 'Field medical response.' },
  { key: 'case_manager', name: 'Case Manager',
    perms: [...allOf('cases'), ...readOf('patients','incidents','missing_persons'),'familia:read'],
    desc: 'Owns case lifecycle.' },
  { key: 'call_center',  name: 'Call Center',
    perms: ['incidents:create','incidents:read','cases:create','cases:read','missing_persons:create','missing_persons:read','familia:read'],
    desc: 'Intake of reports and calls.' },
  { key: 'volunteer',    name: 'Volunteer',
    perms: ['incidents:read','shelters:read','resources:read','volunteers:read'],
    desc: 'Limited operational read access.' },
  { key: 'finance',      name: 'Finance',
    perms: [...allOf('donations','billing'),'reports:read','reports:export','analytics:read'],
    desc: 'Donations, billing and financial reporting.' },
  { key: 'hr',           name: 'Human Resources',
    perms: [...allOf('users'),'teams:read','departments:read','departments:manage'],
    desc: 'Workforce administration.' },
  { key: 'logistics',    name: 'Logistics',
    perms: [...allOf('resources','vehicles','suministros'),'shelters:read'],
    desc: 'Supply chain and assets.' },
  { key: 'developer',    name: 'Developer',
    perms: [...allOf('api_keys','integrations'),'system:read','database:read','monitoring:read','ai:use','ai:manage'],
    desc: 'Technical integration and system access.' },
  { key: 'support',      name: 'Support',
    perms: [...readOf('users','cases','incidents'),'audit:read'],
    desc: 'Read-mostly support staff.' },
  { key: 'read_only',    name: 'Read Only',
    perms: ALL_KEYS.filter((k) => k.endsWith(':read')),
    desc: 'View access across all modules, no writes.' },
  { key: 'guest',        name: 'Guest', perms: [], desc: 'No administrative access.' },
  // ── Legacy mapping (do not delete — preserves live behavior) ──
  { key: 'operator',     name: 'Operator (legacy)',
    inherits: ['emergency_manager','case_manager'],
    perms: ['audit:read','monitoring:read','reports:moderate','familia:moderate','suministros:manage','telemedicina:manage','ops:console',
            'admin:maintenance','contacts:manage','acopio:manage','aid_orgs:manage','emergencia:manage','damage:moderate','persons:moderate','sos:triage','events:refresh','sat:analyze'],
    desc: 'Back-compat role mapped from legacy users.role=operator. Holds the fine-grained per-surface ops permissions (Phase 2 R1) so the gate migration off ops:console is access-preserving.' },
  { key: 'citizen',      name: 'Citizen (legacy)', perms: [], desc: 'Public user mapped from legacy users.role=citizen.' },
];

// ── Role → department assignment (seeded by migrations/0059 onto
// rbac_roles.department_id; departments themselves seeded by 0058). null = a
// cross-cutting executive/utility/public role not owned by a single department. ──
export const ROLE_DEPARTMENTS = {
  operations_director: 'dept_operaciones', emergency_manager: 'dept_operaciones',
  dispatcher: 'dept_operaciones', incident_commander: 'dept_operaciones',
  case_manager: 'dept_operaciones', call_center: 'dept_operaciones',
  volunteer: 'dept_operaciones', operator: 'dept_operaciones',
  medical_director: 'dept_medico', doctor: 'dept_medico', nurse: 'dept_medico', paramedic: 'dept_medico',
  logistics: 'dept_logistica', finance: 'dept_finanzas',
  hr: 'dept_administracion', support: 'dept_administracion', developer: 'dept_tecnologia',
  super_admin: null, owner: null, read_only: null, guest: null, citizen: null,
};

// ── Default field-level policies (sensitive fields) ─────────────────────────
export const FIELD_POLICIES = [
  { resource: 'users',     field: 'phone',         visibility: 'perm', perm: 'users:read' },
  { resource: 'users',     field: 'emergency_contact', visibility: 'perm', perm: 'users:update' },
  { resource: 'patients',  field: 'medical_notes', visibility: 'perm', perm: 'patients:medical_notes' },
  { resource: 'donations', field: 'amount',        visibility: 'perm', perm: 'donations:read' },
  { resource: 'persons',   field: 'gov_id',        visibility: 'perm', perm: 'users:read' },
  { resource: 'incidents', field: 'gps',           visibility: 'perm', perm: 'incidents:gps' },
];

// Resolve a role's transitive permission set (for the seed expansion only).
export function expandRolePerms(roleKey, seen = new Set()) {
  if (seen.has(roleKey)) return new Set();
  seen.add(roleKey);
  const role = ROLES.find((r) => r.key === roleKey);
  if (!role) return new Set();
  if (role.perms === '*') return new Set(ALL_KEYS);
  const out = new Set(role.perms ?? []);
  for (const parent of role.inherits ?? []) {
    for (const p of expandRolePerms(parent, seen)) out.add(p);
  }
  return out;
}

export { ALL_KEYS };
