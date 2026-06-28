// Cmd/Ctrl-K fuzzy command palette: jump to nav sections + quick actions.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { NAV } from '../nav';
import { Icon } from '../icons';
import { navigate } from '../router';
import { fuzzyScore } from '../util';

export interface QuickAction { id: string; label: string; hint: string; icon: keyof typeof Icon; run: () => void }

interface Cmd { id: string; label: string; hint: string; icon: keyof typeof Icon; run: () => void; group: string }

export function CommandPalette({ open, onClose, actions }: { open: boolean; onClose: () => void; actions: QuickAction[] }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const all: Cmd[] = useMemo(() => [
    ...NAV.map((n) => ({ id: 'nav:' + n.id, label: n.label, hint: n.desc, icon: n.icon, group: 'Navegar', run: () => navigate(n.id) })),
    ...actions.map((a) => ({ id: 'act:' + a.id, label: a.label, hint: a.hint, icon: a.icon, group: 'Acciones', run: a.run })),
  ], [actions]);

  const results = useMemo(() => {
    if (!q.trim()) return all;
    return all
      .map((c) => ({ c, s: Math.max(fuzzyScore(q, c.label), fuzzyScore(q, c.hint) - 4) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((r) => r.c);
  }, [q, all]);

  useEffect(() => { if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 30); } }, [open]);
  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const r = results[sel]; if (r) { r.run(); onClose(); } }
  };

  let lastGroup = '';
  return (
    <div class="fixed inset-0 z-[90] flex items-start justify-center pt-[12vh] px-4" role="dialog" aria-modal="true" aria-label="Paleta de comandos">
      <div class="absolute inset-0 bg-black/45 backdrop-blur-[2px] animate-fade-in" onClick={onClose} />
      <div class="relative w-full max-w-xl surface bordered rounded-2xl shadow-palette overflow-hidden animate-scale-in" onKeyDown={onKey}>
        <div class="flex items-center gap-2.5 px-4 border-b">
          <span class="text-faint"><Icon.search size={18} /></span>
          <input
            ref={inputRef}
            class="flex-1 h-12 bg-transparent outline-none text-[14.5px] placeholder:text-[rgb(var(--text-faint))]"
            placeholder="Buscar secciones o acciones…"
            value={q}
            aria-label="Comando"
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          />
          <kbd class="text-[10.5px] font-medium text-faint surface-subtle bordered rounded px-1.5 py-1">ESC</kbd>
        </div>
        <div ref={listRef} class="max-h-[52vh] overflow-y-auto py-1.5">
          {results.length === 0 ? (
            <p class="text-muted text-[13px] text-center py-8">Sin coincidencias.</p>
          ) : results.map((r, i) => {
            const showGroup = r.group !== lastGroup; lastGroup = r.group;
            const I = Icon[r.icon];
            const on = i === sel;
            return (
              <div key={r.id}>
                {showGroup && <div class="label-caps px-4 pt-2.5 pb-1">{r.group}</div>}
                <button
                  data-sel={on}
                  class={`w-full flex items-center gap-3 px-3 mx-1.5 rounded-lg py-2 text-left transition-colors ${on ? 'bg-[rgb(var(--bg-hover))]' : ''}`}
                  style={{ width: 'calc(100% - 12px)' }}
                  onMouseMove={() => setSel(i)}
                  onClick={() => { r.run(); onClose(); }}
                >
                  <span class={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${on ? 'text-[rgb(var(--accent))]' : 'text-faint'} surface-subtle bordered`}><I size={16} /></span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-[13.5px] font-medium truncate">{r.label}</span>
                    <span class="block text-[12px] text-faint truncate">{r.hint}</span>
                  </span>
                  {on && <Icon.chevron size={15} class="text-faint shrink-0" />}
                </button>
              </div>
            );
          })}
        </div>
        <div class="flex items-center gap-3 px-4 py-2 border-t text-[11.5px] text-faint surface-subtle">
          <span class="flex items-center gap-1"><kbd class="surface bordered rounded px-1">↑</kbd><kbd class="surface bordered rounded px-1">↓</kbd> navegar</span>
          <span class="flex items-center gap-1"><kbd class="surface bordered rounded px-1">↵</kbd> seleccionar</span>
        </div>
      </div>
    </div>
  );
}
