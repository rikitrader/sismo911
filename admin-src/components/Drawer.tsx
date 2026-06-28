// Right-side slide-in drawer with overlay, ESC-to-close and focus trapping.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { Icon } from '../icons';

export function Drawer({
  open, onClose, title, subtitle, width = 480, children, footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ComponentChildren;
  subtitle?: ComponentChildren;
  width?: number;
  children: ComponentChildren;
  footer?: ComponentChildren;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    const t = setTimeout(() => panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus(), 60);
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; clearTimeout(t); };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div class="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <div class="absolute inset-0 bg-black/40 backdrop-blur-[1px] animate-fade-in" onClick={onClose} />
      <div
        ref={panelRef}
        class="absolute top-0 right-0 h-full surface shadow-drawer border-l flex flex-col animate-slide-in"
        style={{ width: Math.min(width, typeof window !== 'undefined' ? window.innerWidth : width), maxWidth: '100vw' }}
      >
        <header class="flex items-start justify-between gap-3 px-5 py-4 border-b shrink-0">
          <div class="min-w-0">
            <div class="text-[15px] font-semibold leading-tight truncate">{title}</div>
            {subtitle && <div class="text-muted text-[12.5px] mt-0.5 truncate">{subtitle}</div>}
          </div>
          <button class="btn btn-ghost btn-sm -mr-2 -mt-1 px-2" aria-label="Cerrar panel" onClick={onClose}>
            <Icon.close size={16} />
          </button>
        </header>
        <div class="flex-1 overflow-y-auto">{children}</div>
        {footer && <footer class="border-t px-5 py-3.5 shrink-0 surface-subtle">{footer}</footer>}
      </div>
    </div>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: string }[]; active: string; onChange: (id: string) => void }) {
  return (
    <div class="flex gap-1 px-5 border-b sticky top-0 surface z-10" role="tablist">
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={on}
            class={`relative px-3 py-2.5 text-[13px] font-medium transition-colors focusable ${on ? 'text-[rgb(var(--text))]' : 'text-faint hover:text-muted'}`}
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {on && <span class="absolute left-2 right-2 -bottom-px h-0.5 rounded-full" style={{ background: 'rgb(var(--accent))' }} />}
          </button>
        );
      })}
    </div>
  );
}
