// Small shared helpers.
import type { UserStatus } from './api';

export function relTime(ms?: number | null): string {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 0) return 'ahora';
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'hace ' + s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return 'hace ' + m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return 'hace ' + h + 'h';
  const d = Math.floor(h / 24);
  if (d < 30) return 'hace ' + d + 'd';
  return new Date(ms).toLocaleDateString();
}

export function fullTime(ms?: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

export function initials(name?: string, email?: string): string {
  const src = (name || email || '?').trim();
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

// Stable hue from a string → avatar gradient.
export function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export const STATUS_META: Record<UserStatus, { label: string; cls: string; dot: string }> = {
  active: { label: 'Activo', cls: 'bg-ok/12 text-ok', dot: 'bg-ok' },
  suspended: { label: 'Suspendido', cls: 'bg-danger/12 text-danger', dot: 'bg-danger' },
  pending: { label: 'Pendiente', cls: 'bg-warn/15 text-warn', dot: 'bg-warn' },
  locked: { label: 'Bloqueado', cls: 'bg-zinc-500/15 text-faint', dot: 'bg-zinc-500' },
};

// Simple fuzzy subsequence match → score (higher = better), or -1 if no match.
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let qi = 0, score = 0, streak = 0, prev = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      streak++;
      score += 1 + streak * 2 + (prev === ti - 1 ? 3 : 0) + (ti === 0 ? 5 : 0);
      prev = ti;
      qi++;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : -1;
}
