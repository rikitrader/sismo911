// Persistent, impossible-to-miss warning shown whenever an admin is impersonating
// another user. Presence is driven entirely by the `sismo_impersonating` cookie
// (set server-side on POST /impersonate/:id). Full-width, high-contrast, sticky.
import { useState, useEffect, useCallback } from 'preact/hooks';
import { rbac } from '../api';
import { Icon } from '../icons';
import { Spinner } from './ui';
import { toast } from '../toast';

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.*+?^${}()|[\]\\])/g, '\\$1') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

// The cookie may carry a bare name/email or a JSON blob like {name,email,id}.
function displayName(raw: string | null): string {
  if (!raw) return 'un usuario';
  try {
    const o = JSON.parse(raw);
    return o.name || o.preferred_name || o.email || o.username || o.id || 'un usuario';
  } catch {
    return raw;
  }
}

export function ImpersonationBanner() {
  const [cookie, setCookie] = useState<string | null>(() => readCookie('sismo_impersonating'));
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => setCookie(readCookie('sismo_impersonating')), []);

  useEffect(() => {
    // Re-check on focus/visibility and on a light interval so the banner appears
    // or disappears promptly even when the cookie changes out of band.
    const onFocus = () => refresh();
    const onVis = () => { if (!document.hidden) refresh(); };
    addEventListener('focus', onFocus);
    addEventListener('rbac-impersonation-changed', onFocus);
    document.addEventListener('visibilitychange', onVis);
    const t = setInterval(refresh, 4000);
    return () => {
      removeEventListener('focus', onFocus);
      removeEventListener('rbac-impersonation-changed', onFocus);
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(t);
    };
  }, [refresh]);

  if (!cookie) return null;
  const name = displayName(cookie);

  async function stop() {
    setBusy(true);
    try {
      await rbac.stopImpersonate();
      location.reload();
    } catch (e: any) {
      toast.error(e?.message || 'No se pudo detener la suplantación');
      setBusy(false);
    }
  }

  return (
    <div
      role="alert"
      class="sticky top-0 z-[100] w-full flex items-center justify-center gap-3 px-4 py-2.5 text-white shadow-lg"
      style={{ background: 'repeating-linear-gradient(45deg, #b91c1c, #b91c1c 14px, #9f1414 14px, #9f1414 28px)' }}
    >
      <span class="shrink-0 animate-pulse"><Icon.alert size={18} /></span>
      <span class="text-[13.5px] font-semibold tracking-tight text-center">
        Suplantando a <span class="underline underline-offset-2">{name}</span> — estás viendo el sistema como este usuario
      </span>
      <button
        class="shrink-0 inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-white text-[#991b1b] text-[12.5px] font-bold hover:bg-white/90 transition-colors focusable disabled:opacity-70"
        disabled={busy}
        onClick={stop}
      >
        {busy ? <Spinner size={14} /> : <Icon.close size={14} />} Detener
      </button>
    </div>
  );
}
