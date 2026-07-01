// SISMO911 — Live-seismic Telegram bot: pure formatting + command parsing.
// ---------------------------------------------------------------------------
// Deterministic, no DB/network. Turns real seismic rows (from /api/events data
// helpers) + the threat score into Telegram text. All data is PUBLIC, non-PII
// (magnitude, place, depth, MMI, PAGER alert, tsunami flag, time) — this bot
// never touches the case/person registries.

export type SismosCommand =
  | 'ultimo'
  | 'sismos'
  | 'estado'
  | 'colores'
  | 'suscribir'
  | 'cancelar'
  | 'ayuda'
  | 'unknown';

export interface ParsedSismos {
  kind: SismosCommand;
  count?: number; // for /sismos N
}

const ALIASES: Record<string, SismosCommand> = {
  ultimo: 'ultimo', último: 'ultimo', last: 'ultimo', latest: 'ultimo',
  sismos: 'sismos', quakes: 'sismos', recientes: 'sismos', recent: 'sismos', lista: 'sismos',
  estado: 'estado', status: 'estado', nivel: 'estado', alerta: 'estado',
  colores: 'colores', leyenda: 'colores', escala: 'colores', colors: 'colores', legend: 'colores', chart: 'colores', niveles: 'colores',
  suscribir: 'suscribir', suscribirme: 'suscribir', subscribe: 'suscribir', alertas: 'suscribir', seguir: 'suscribir',
  cancelar: 'cancelar', unsubscribe: 'cancelar', stop: 'cancelar', detener: 'cancelar',
  ayuda: 'ayuda', help: 'ayuda', start: 'ayuda', menu: 'ayuda', comandos: 'ayuda', commands: 'ayuda',
};

const GREET = new Set(['hola', 'hi', 'hello', 'buenas', 'hey', 'ola', 'saludos']);

/** Parse a chat line into a seismic-bot command. Tolerates a leading
 *  @bot-mention, an optional "/", and a trailing count for /sismos. */
export function parseSismosCommand(text: string): ParsedSismos {
  const toks = (text ?? '').trim().split(/\s+/).filter(Boolean);
  while (toks.length && toks[0].startsWith('@')) toks.shift();
  if (!toks.length) return { kind: 'ayuda' };
  let head = toks[0];
  if (head.startsWith('/')) head = head.slice(1).split('@')[0];
  const word = head.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const kind = ALIASES[word] ?? (GREET.has(word) ? 'ayuda' : 'unknown');
  const out: ParsedSismos = { kind };
  if (kind === 'sismos') {
    const n = Number(toks[1]);
    if (Number.isFinite(n) && n >= 1) out.count = Math.min(20, Math.floor(n));
  }
  return out;
}

// ---- formatting -------------------------------------------------------------

function fmtDate(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

const ALERT_ES: Record<string, string> = { green: 'verde', yellow: 'amarilla', orange: 'naranja', red: 'roja' };

// Civil-protection alert scale. Index = scoreThreat level (0 = sin datos, 1-4).
// Each level carries a clear "qué hacer" action from stay-put → evacuate.
export interface LevelInfo { emoji: string; label: string; desc: string; action: string; }
export const LEVELS: LevelInfo[] = [
  { emoji: '⚪', label: 'Sin datos', desc: 'Sin información sísmica reciente.', action: 'Mantente informado.' },
  { emoji: '🟢', label: 'Normal (nivel 1)', desc: 'Actividad sísmica baja o sin sismos relevantes.', action: 'Sin acción especial. Ten tu kit de emergencia y tu plan familiar listos.' },
  { emoji: '🟡', label: 'Moderado (nivel 2)', desc: 'Sismos leves o enjambre menor; posibles réplicas.', action: 'Atención. Revisa tu plan y tu ruta de salida; asegura objetos que puedan caer.' },
  { emoji: '🟠', label: 'Elevado (nivel 3)', desc: 'Sismo fuerte reciente o réplicas frecuentes; riesgo de daños.', action: 'Prepárate para salir: aléjate de estructuras dañadas, ventanas y postes; ten a mano documentos y kit; define tu punto de encuentro.' },
  { emoji: '🔴', label: 'Alto (nivel 4)', desc: 'Peligro alto (sismo mayor, alerta PAGER roja, o riesgo de tsunami/deslizamiento).', action: '¡EVACÚA AHORA! Sal de los edificios y de las zonas de riesgo (costa por tsunami, laderas por deslizamiento). Muévete a terreno abierto y seguro, FUERA del rango de peligro. Sigue a Protección Civil.' },
];

/** Recommended action for a single quake, by PAGER alert (or magnitude). */
export function quakeAction(e: any): string {
  const a = String(e?.alert ?? '').toLowerCase();
  const m = Number(e?.mag) || 0;
  if (a === 'red' || m >= 6.5) return LEVELS[4].action;
  if (a === 'orange' || m >= 5.5) return '⚠️ Prepárate para salir: aléjate de estructuras dañadas y ventanas; ten lista tu ruta y tu punto de encuentro.';
  if (a === 'yellow' || m >= 4.5) return 'Atención: mantén la calma y prepárate para réplicas; revisa tu entorno por daños.';
  return 'Sin acción especial. Mantente informado.';
}

/** The color/alert scale with what-to-do guidance (the /colores chart). */
export function formatColorChart(): string {
  const rows = LEVELS.slice(1).map((l) => `${l.emoji} ${l.label}\n   ${l.desc}\n   👉 ${l.action}`);
  return [
    '🎨 Escala de alerta sísmica — SISMO911',
    '',
    ...rows,
    '',
    'En cada sismo el color viene de la alerta PAGER (USGS): 🟢 verde · 🟡 amarilla · 🟠 naranja · 🔴 roja. Si no hay alerta, se estima por la magnitud (M≥6 🔴 · M≥5 🟠 · M≥4 🟡).',
    'Guía completa: https://sismo911.com/guia',
  ].join('\n');
}

/** Severity emoji: PAGER alert if present, else derived from magnitude. */
export function quakeEmoji(e: any): string {
  const a = String(e?.alert ?? '').toLowerCase();
  if (a === 'red') return '🔴';
  if (a === 'orange') return '🟠';
  if (a === 'yellow') return '🟡';
  if (a === 'green') return '🟢';
  const m = Number(e?.mag) || 0;
  if (m >= 6) return '🔴';
  if (m >= 5) return '🟠';
  if (m >= 4) return '🟡';
  return '⚪';
}

function placeOf(e: any): string {
  return e?.place_es || e?.place || 'Venezuela';
}

const BASE = 'https://sismo911.com';

/** One-quake block (full detail). */
export function formatQuake(e: any, baseUrl = BASE): string {
  const mag = e?.mag != null ? `M${e.mag}` : 'M—';
  const bits: string[] = [];
  if (e?.depth_km != null) bits.push(`prof. ${Math.round(e.depth_km)} km`);
  if (e?.mmi != null) bits.push(`MMI ${e.mmi}`);
  if (e?.alert && ALERT_ES[String(e.alert).toLowerCase()]) bits.push(`alerta ${ALERT_ES[String(e.alert).toLowerCase()]}`);
  if (e?.tsunami) bits.push('🌊 aviso de tsunami');
  const line2 = bits.length ? `${bits.join(' · ')}\n` : '';
  const link = e?.url || `${baseUrl}/terremotos`;
  return `${quakeEmoji(e)} Sismo ${mag} — ${placeOf(e)}\n${line2}${fmtDate(e?.time_ms)}\nDetalle: ${link}`;
}

/** Compact one-liner for a list. */
export function formatQuakeLine(e: any): string {
  const mag = e?.mag != null ? `M${e.mag}` : 'M—';
  const depth = e?.depth_km != null ? `, ${Math.round(e.depth_km)} km` : '';
  return `${quakeEmoji(e)} ${mag} — ${placeOf(e)} (${fmtDate(e?.time_ms)}${depth})`;
}

/** Recent-quakes list. */
export function formatQuakeList(events: any[]): string {
  if (!events.length) return 'No hay sismos recientes en el registro.';
  const header = `Últimos ${events.length} sismos (VE):`;
  return [header, '', ...events.map(formatQuakeLine)].join('\n');
}

/** Current threat status ("Estado Actual") + the driving quake. */
export function formatThreat(threat: any, latest: any | null): string {
  const dot = ['⚪', '🟢', '🟡', '🟠', '🔴'][threat?.level ?? 0] ?? '⚪';
  const lines = [
    `${dot} Estado sísmico: ${threat?.label ?? 'Sin datos'} (nivel ${threat?.level ?? '—'}/4, índice ${threat?.score ?? '—'}/100)`,
  ];
  if (threat?.reason) lines.push(threat.reason);
  if (threat?.max_mag_48h != null) lines.push(`Máx. 48h: M${threat.max_mag_48h} · réplicas 6h (M≥3.5): ${threat.recent_6h ?? 0}`);
  if (Array.isArray(threat?.sources) && threat.sources.length) lines.push(`Fuentes: ${threat.sources.join(', ')}`);
  if (latest) {
    lines.push('');
    lines.push('Último sismo:');
    lines.push(formatQuakeLine(latest));
  }
  const lvl = LEVELS[threat?.level ?? 0] ?? LEVELS[0];
  lines.push('');
  lines.push(`👉 Qué hacer: ${lvl.action}`);
  return lines.join('\n');
}

/** Push message when a new quake lands (includes the what-to-do action). */
export function formatQuakeAlert(e: any, baseUrl = BASE): string {
  return `🚨 ALERTA SÍSMICA\n${formatQuake(e, baseUrl)}\n\n👉 ${quakeAction(e)}\n\nGuía: ${baseUrl}/guia`;
}

export const HELP_SISMOS = [
  '🌎 SISMO911 en vivo — datos sísmicos de Venezuela (USGS + FUNVISIS).',
  '',
  'Comandos:',
  '• /ultimo — el sismo más reciente',
  '• /sismos [n] — últimos n sismos (máx. 20)',
  '• /estado — estado/alerta sísmica actual',
  '• /colores — escala de colores y qué hacer en cada nivel',
  '• /suscribir — recibir alertas automáticas de sismos fuertes',
  '• /cancelar — dejar de recibir alertas',
  '• /ayuda — mostrar esta ayuda',
  '',
  'Datos públicos, sin información personal. Web: https://sismo911.com/terremotos',
].join('\n');
