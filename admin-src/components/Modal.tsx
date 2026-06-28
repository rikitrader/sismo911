// Centered modal dialog.
import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { Icon } from '../icons';

export function Modal({ open, onClose, title, children, footer, width = 440 }: {
  open: boolean; onClose: () => void; title: ComponentChildren; children: ComponentChildren; footer?: ComponentChildren; width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div class="fixed inset-0 z-[80] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div class="absolute inset-0 bg-black/45 backdrop-blur-[2px] animate-fade-in" onClick={onClose} />
      <div class="relative surface bordered rounded-2xl shadow-palette w-full animate-scale-in" style={{ maxWidth: width }}>
        <header class="flex items-center justify-between px-5 py-4 border-b">
          <h2 class="text-[15px] font-semibold">{title}</h2>
          <button class="btn btn-ghost btn-sm px-2 -mr-2" aria-label="Cerrar" onClick={onClose}><Icon.close size={16} /></button>
        </header>
        <div class="px-5 py-4">{children}</div>
        {footer && <footer class="px-5 py-3.5 border-t flex justify-end gap-2 surface-subtle rounded-b-2xl">{footer}</footer>}
      </div>
    </div>
  );
}
