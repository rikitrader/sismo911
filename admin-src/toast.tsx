// Minimal toast system: a module-level pub/sub + a host component.
import { useState, useEffect } from 'preact/hooks';
import { Icon } from './icons';

export type ToastKind = 'success' | 'error' | 'info';
interface Toast { id: number; kind: ToastKind; msg: string }

let seq = 1;
let toasts: Toast[] = [];
const listeners = new Set<(t: Toast[]) => void>();

function emit() { listeners.forEach((l) => l(toasts.slice())); }

export function toast(msg: string, kind: ToastKind = 'info') {
  const t: Toast = { id: seq++, kind, msg };
  toasts = [...toasts, t];
  emit();
  setTimeout(() => dismiss(t.id), kind === 'error' ? 6000 : 3800);
}
toast.success = (m: string) => toast(m, 'success');
toast.error = (m: string) => toast(m, 'error');

function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

const tone: Record<ToastKind, { c: string; icon: any }> = {
  success: { c: 'text-ok', icon: Icon.check },
  error: { c: 'text-danger', icon: Icon.alert },
  info: { c: 'text-info', icon: Icon.circle },
};

export function ToastHost() {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    listeners.add(setList);
    return () => { listeners.delete(setList); };
  }, []);
  return (
    <div class="fixed bottom-5 right-5 z-[100] flex flex-col gap-2.5 w-[340px] max-w-[calc(100vw-2rem)]" role="status" aria-live="polite">
      {list.map((t) => {
        const T = tone[t.kind];
        return (
          <div key={t.id} class="surface bordered shadow-pop rounded-xl px-3.5 py-3 flex items-start gap-3 animate-toast-in">
            <span class={`mt-0.5 ${T.c}`}><T.icon size={18} /></span>
            <p class="text-[13px] leading-snug flex-1 pt-px">{t.msg}</p>
            <button class="text-faint hover:text-[rgb(var(--text))] -mr-1 -mt-1 p-1 rounded focusable" aria-label="Cerrar" onClick={() => dismiss(t.id)}>
              <Icon.close size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
