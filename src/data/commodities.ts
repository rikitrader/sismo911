// FEMA/NIMS commodity taxonomy for the centros-de-acopio logistics subsystem.
// Aligned to U.S. Emergency Support Functions (ESF) adapted to the SISMO911
// "AI Corp Federal" ESF model used by /agencias. Used by:
//   - migrations/0020_acopio_logistica.sql (commodity ids stored in inventory/needs/manifest)
//   - src/routes/logistica.ts (validation + default units)
//   - public/logistica.html + public/acopio.html (labels, icons, colors)
// Keep COMMODITY ids stable — they are persisted in D1.

export interface Commodity {
  id: string;     // stable key persisted in D1
  label: string;  // Spanish display label
  icon: string;   // emoji for map/list/dashboard
  unit: string;   // default unit of measure
  esf: number;    // Emergency Support Function number
  color: string;  // hex for charts/badges
}

export const COMMODITIES: Commodity[] = [
  { id: 'agua',           label: 'Agua potable',     icon: '💧', unit: 'l',    esf: 6,  color: '#0891b2' },
  { id: 'alimentos',      label: 'Alimentos',        icon: '🥫', unit: 'caja', esf: 11, color: '#16a34a' },
  { id: 'medicinas',      label: 'Medicinas',        icon: '💊', unit: 'caja', esf: 8,  color: '#bb0027' },
  { id: 'abrigo',         label: 'Abrigo / refugio', icon: '🛏️', unit: 'u',    esf: 6,  color: '#7c3aed' },
  { id: 'higiene',        label: 'Higiene',          icon: '🧼', unit: 'kit',  esf: 6,  color: '#0ea5e9' },
  { id: 'infantil',       label: 'Infantil / bebé',  icon: '🍼', unit: 'kit',  esf: 6,  color: '#ec4899' },
  { id: 'energia',        label: 'Energía / combustible', icon: '🔋', unit: 'u', esf: 12, color: '#d97706' },
  { id: 'rescate',        label: 'Rescate / SAR',    icon: '⛑️', unit: 'u',    esf: 9,  color: '#ea580c' },
  { id: 'comunicaciones', label: 'Comunicaciones',   icon: '📡', unit: 'u',    esf: 2,  color: '#475569' },
  { id: 'logistica',      label: 'Logística / carga', icon: '📦', unit: 'u',   esf: 7,  color: '#00173a' },
];

export const COMMODITY_IDS = new Set(COMMODITIES.map((c) => c.id));

export const COMMODITY_UNIT: Record<string, string> = Object.fromEntries(
  COMMODITIES.map((c) => [c.id, c.unit])
);
