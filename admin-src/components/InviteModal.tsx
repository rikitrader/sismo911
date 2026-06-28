// Rich invitation modal: choose channel (email / SMS / QR), create the invite,
// then surface a copyable link and — for the QR channel — a scannable QR code.
// Shared by the Users and Invitations pages.
import { useState, useEffect, useMemo } from 'preact/hooks';
import { rbac } from '../api';
import type { InviteChannel } from '../api';
import { useResource } from '../hooks';
import { Modal } from './Modal';
import { Field, Spinner } from './ui';
import { qrMatrix } from '../qr';
import { Icon } from '../icons';
import { toast } from '../toast';

// Render a QR matrix as a crisp, theme-agnostic SVG (white quiet zone so any
// phone camera reads it on both light and dark consoles).
function QrSvg({ text, size = 196 }: { text: string; size?: number }) {
  const svg = useMemo(() => {
    let matrix: boolean[][] | null = null;
    try { matrix = qrMatrix(text, 'M'); } catch { matrix = null; }
    if (!matrix) return null;
    const n = matrix.length;
    const quiet = 4;
    const dim = n + quiet * 2;
    let path = '';
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        if (matrix[y][x]) path += `M${x + quiet},${y + quiet}h1v1h-1z`;
    return { dim, path };
  }, [text]);
  if (!svg) return null;
  return (
    <svg
      width={size} height={size} viewBox={`0 0 ${svg.dim} ${svg.dim}`}
      shape-rendering="crispEdges" role="img" aria-label="Código QR de invitación" class="rounded-lg"
    >
      <rect width={svg.dim} height={svg.dim} fill="#ffffff" />
      <path d={svg.path} fill="#000000" />
    </svg>
  );
}

const CHANNELS: { id: InviteChannel; label: string; icon: keyof typeof Icon }[] = [
  { id: 'email', label: 'Correo', icon: 'mail' },
  { id: 'sms', label: 'SMS', icon: 'phone' },
  { id: 'qr', label: 'Código QR', icon: 'permissions' },
];

export function InviteModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone?: () => void }) {
  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState('');
  const [channel, setChannel] = useState<InviteChannel>('email');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ link: string; channel: InviteChannel } | null>(null);
  const rolesRes = useResource(() => rbac.roles(), [open]);

  useEffect(() => {
    if (open) { setEmail(''); setRoleKey(''); setChannel('email'); setPhone(''); setResult(null); }
  }, [open]);

  const emailValid = /\S+@\S+\.\S+/.test(email.trim());
  const phoneNeeded = channel === 'sms';
  const canSubmit = emailValid && (!phoneNeeded || phone.trim().length >= 6);

  async function submit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    try {
      const res = await rbac.createInvitation({
        email: email.trim(),
        roleKey: roleKey || undefined,
        channel,
        phone: phoneNeeded ? phone.trim() : undefined,
      });
      const link = res.link || (res.token ? `${location.origin}/invite/${res.token}` : '');
      setResult({ link, channel });
      toast.success(
        channel === 'email' ? 'Invitación enviada por correo'
        : channel === 'sms' ? 'Invitación enviada por SMS'
        : 'Invitación creada',
      );
      onDone?.();
    } catch (e: any) {
      toast.error(e?.message || 'No se pudo crear la invitación');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Invitar usuario" width={460}
      footer={!result && (
        <>
          <button class="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button class="btn btn-primary" disabled={busy || !canSubmit} onClick={submit}>
            {busy ? <Spinner /> : <Icon.plus size={16} />} Crear invitación
          </button>
        </>
      )}>
      {result ? (
        <div class="text-center py-1">
          <div class="w-12 h-12 rounded-xl bg-ok/12 text-ok flex items-center justify-center mx-auto mb-3"><Icon.check size={24} /></div>
          <p class="font-medium text-[14px]">Invitación lista</p>
          <p class="text-faint text-[12.5px] mt-1 mb-4">
            {result.channel === 'qr'
              ? 'Pide a la persona que escanee este código para unirse.'
              : <>Comparte este enlace con <b>{email}</b>.</>}
          </p>
          {result.channel === 'qr' && result.link && (
            <div class="flex justify-center mb-4"><div class="p-3 surface-subtle bordered rounded-xl"><QrSvg text={result.link} /></div></div>
          )}
          {result.link && (
            <div class="flex items-center gap-2 surface-subtle bordered rounded-lg px-3 py-2 text-left">
              <Icon.link size={15} class="text-faint shrink-0" />
              <span class="text-[12px] font-mono truncate flex-1">{result.link}</span>
              <button class="btn btn-ghost btn-sm px-2" aria-label="Copiar enlace"
                onClick={() => { navigator.clipboard?.writeText(result.link); toast.success('Enlace copiado'); }}><Icon.copy size={15} /></button>
            </div>
          )}
          <button class="btn btn-outline w-full mt-4" onClick={onClose}>Listo</button>
        </div>
      ) : (
        <div class="space-y-4">
          <Field label="Correo electrónico">
            <input class="input" type="email" placeholder="persona@sismo911.com" data-autofocus value={email}
              onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </Field>

          <div>
            <span class="label-caps block mb-1.5">Canal de envío</span>
            <div class="grid grid-cols-3 gap-2">
              {CHANNELS.map((c) => {
                const I = Icon[c.icon];
                const on = channel === c.id;
                return (
                  <button key={c.id} type="button" aria-pressed={on}
                    class={`flex flex-col items-center gap-1.5 py-2.5 rounded-lg border transition-colors ${on ? 'bg-brand-500/15 text-[rgb(var(--accent))] border-brand-500/40' : 'surface-subtle bordered text-muted hover:text-[rgb(var(--text))]'}`}
                    onClick={() => setChannel(c.id)}>
                    <I size={18} /><span class="text-[12px] font-medium">{c.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {phoneNeeded && (
            <Field label="Teléfono" hint="Incluye el código de país, ej. +58…">
              <input class="input" type="tel" placeholder="+58 412 000 0000" value={phone}
                onInput={(e) => setPhone((e.target as HTMLInputElement).value)} />
            </Field>
          )}

          <Field label="Rol inicial (opcional)">
            <select class="input" value={roleKey} onChange={(e) => setRoleKey((e.target as HTMLSelectElement).value)}>
              <option value="">Sin rol</option>
              {(rolesRes.data?.roles || []).map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}
            </select>
          </Field>
        </div>
      )}
    </Modal>
  );
}
