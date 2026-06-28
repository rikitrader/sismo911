import { useState, useMemo } from 'preact/hooks';
import { rbac } from '../api';
import type { MfaEnroll } from '../api';
import { PageHeader, Field, Spinner } from '../components/ui';
import { qrMatrix } from '../qr';
import { Icon } from '../icons';
import { toast } from '../toast';

// Render a QR matrix as a crisp, theme-agnostic SVG (white quiet zone so any
// authenticator camera reads it on both light and dark consoles).
function QrSvg({ text, size = 184 }: { text: string; size?: number }) {
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
      shape-rendering="crispEdges" role="img" aria-label="Código QR de configuración MFA"
      class="rounded-lg"
    >
      <rect width={svg.dim} height={svg.dim} fill="#ffffff" />
      <path d={svg.path} fill="#000000" />
    </svg>
  );
}

function copy(text: string, msg = 'Copiado') {
  navigator.clipboard?.writeText(text); toast.success(msg);
}

export function SecurityPage() {
  // Flow: idle → enrolling (QR + verify) → done (backup codes shown once).
  const [enroll, setEnroll] = useState<MfaEnroll | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [showDisable, setShowDisable] = useState(false);
  const [disableCode, setDisableCode] = useState('');

  async function startEnroll() {
    setBusy(true);
    try {
      const res = await rbac.mfaEnroll();
      setEnroll(res); setBackupCodes(null); setCode('');
    } catch (e: any) { toast.error(e?.message || 'No se pudo iniciar la inscripción MFA'); }
    finally { setBusy(false); }
  }

  async function verify() {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const res = await rbac.mfaVerify(code.trim());
      const codes = res.backup_codes || res.backupCodes || [];
      setBackupCodes(codes);
      setEnroll(null);
      toast.success('MFA activado');
    } catch (e: any) { toast.error(e?.message || 'Código incorrecto, intenta de nuevo'); }
    finally { setBusy(false); }
  }

  async function disable() {
    if (!disableCode.trim()) return;
    setBusy(true);
    try {
      await rbac.mfaDisable(disableCode.trim());
      toast.success('MFA desactivado');
      setShowDisable(false); setDisableCode('');
    } catch (e: any) { toast.error(e?.message || 'No se pudo desactivar MFA'); }
    finally { setBusy(false); }
  }

  function downloadCodes() {
    if (!backupCodes) return;
    const blob = new Blob([`SISMO911 — códigos de respaldo MFA\n\n${backupCodes.join('\n')}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'sismo911-mfa-backup-codes.txt';
    a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div class="animate-fade-in max-w-2xl">
      <PageHeader title="Seguridad" subtitle="Autenticación de dos factores (MFA) para tu cuenta" />

      {/* Backup codes (shown once after verification) */}
      {backupCodes && (
        <div class="card p-5 mb-5 animate-scale-in">
          <div class="flex items-center gap-2.5 mb-3">
            <span class="w-9 h-9 rounded-lg bg-ok/12 text-ok flex items-center justify-center"><Icon.check size={18} /></span>
            <div>
              <div class="font-semibold text-[15px]">MFA activado</div>
              <div class="text-faint text-[12.5px]">Guarda estos códigos de respaldo. No se mostrarán de nuevo.</div>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-1.5 surface-subtle bordered rounded-lg p-3 font-mono text-[13px]">
            {backupCodes.map((c) => <span key={c} class="px-1.5 py-1 select-all">{c}</span>)}
          </div>
          <div class="flex gap-2 mt-4">
            <button class="btn btn-outline" onClick={() => copy(backupCodes.join('\n'), 'Códigos copiados')}><Icon.copy size={15} /> Copiar</button>
            <button class="btn btn-outline" onClick={downloadCodes}><Icon.download size={15} /> Descargar</button>
            <button class="btn btn-primary ml-auto" onClick={() => setBackupCodes(null)}>Listo</button>
          </div>
        </div>
      )}

      {/* Enrollment in progress */}
      {enroll && (
        <div class="card p-5 mb-5">
          <div class="font-semibold text-[15px] mb-1">Configura tu aplicación de autenticación</div>
          <p class="text-faint text-[12.5px] mb-4">Escanea el código QR con Google Authenticator, 1Password o similar, luego introduce el código de 6 dígitos.</p>
          <div class="flex flex-col sm:flex-row gap-5">
            <div class="shrink-0 mx-auto sm:mx-0">
              <div class="p-3 bg-white rounded-xl bordered inline-block"><QrSvg text={enroll.otpauth_uri} /></div>
            </div>
            <div class="flex-1 min-w-0">
              <div class="label-caps mb-1.5">Entrada manual</div>
              <div class="flex items-center gap-2 surface-subtle bordered rounded-lg px-3 py-2 mb-4">
                <span class="text-[13px] font-mono truncate flex-1 select-all">{enroll.secret}</span>
                <button class="btn btn-ghost btn-sm px-2" aria-label="Copiar secreto" onClick={() => copy(enroll.secret, 'Secreto copiado')}><Icon.copy size={15} /></button>
              </div>
              <Field label="Código de verificación">
                <input
                  class="input font-mono tracking-[0.3em] text-center" inputMode="numeric" maxLength={6}
                  placeholder="000000" value={code} data-autofocus
                  onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))}
                  onKeyDown={(e) => e.key === 'Enter' && verify()}
                />
              </Field>
              <div class="flex gap-2 mt-4">
                <button class="btn btn-ghost" disabled={busy} onClick={() => setEnroll(null)}>Cancelar</button>
                <button class="btn btn-primary ml-auto" disabled={busy || code.length < 6} onClick={verify}>{busy ? <Spinner /> : <Icon.check size={16} />} Verificar y activar</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Idle actions */}
      {!enroll && !backupCodes && (
        <div class="card p-5">
          <div class="flex items-start gap-3.5">
            <span class="w-11 h-11 rounded-xl surface-subtle bordered flex items-center justify-center text-faint shrink-0"><Icon.shield size={22} /></span>
            <div class="flex-1">
              <div class="font-semibold text-[15px]">App de autenticación (TOTP)</div>
              <p class="text-faint text-[13px] mt-1 leading-relaxed">Añade un segundo factor con un código temporal de tu app de autenticación. Recomendado para todas las cuentas de administrador.</p>
              <div class="flex flex-wrap gap-2 mt-4">
                <button class="btn btn-primary" disabled={busy} onClick={startEnroll}>{busy ? <Spinner /> : <Icon.key size={16} />} Configurar MFA</button>
                <button class="btn btn-danger" disabled={busy} onClick={() => setShowDisable((v) => !v)}><Icon.lock size={15} /> Desactivar MFA</button>
              </div>

              {showDisable && (
                <div class="mt-4 surface-subtle bordered rounded-lg p-4 animate-fade-in">
                  <div class="label-caps mb-1.5">Confirma para desactivar</div>
                  <p class="text-faint text-[12.5px] mb-3">Introduce un código actual de tu app de autenticación para desactivar MFA.</p>
                  <div class="flex gap-2">
                    <input
                      class="input font-mono tracking-[0.3em] text-center max-w-[160px]" inputMode="numeric" maxLength={6}
                      placeholder="000000" value={disableCode}
                      onInput={(e) => setDisableCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))}
                      onKeyDown={(e) => e.key === 'Enter' && disable()}
                    />
                    <button class="btn btn-danger" disabled={busy || disableCode.length < 6} onClick={disable}>{busy ? <Spinner /> : null} Desactivar</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
