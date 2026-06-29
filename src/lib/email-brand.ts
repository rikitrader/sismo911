// ---------------------------------------------------------------------------
// SISMO911 branded email shell. Every transactional email renders through
// renderBranded() so they all share the same look: navy header bar with the
// sismo911.com logo, seismic-cyan accent, big display headline, body, optional
// button + security callout + details, signature, and footer. Mirrors the
// approved sample "[MUESTRA] Inicia sesión en SISMO911 — enlace de acceso".
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

const BRAND = {
  logo: 'https://sismo911.com/logo.png',
  site: 'sismo911.com',
  siteUrl: 'https://sismo911.com',
  from: 'alerts@sismo911.com',
  wordmark: 'SISMO911 · CENTRO DE OPERACIONES',
  bg: '#eef2f6',
  navy: '#0b1830',
  accent: '#38bdf8',
  eyebrow: '#0ea5e9',
  body: '#475569',
  muted: '#94a3b8',
  card: '#ffffff',
};

export interface BrandedEmailInput {
  subject: string;
  eyebrow: string; // small uppercase kicker
  heading: string; // H1
  roleTag?: string; // header-bar right label, default OPERADOR
  paras?: string[]; // body paragraphs (plain text, escaped)
  details?: { label: string; value: string }[]; // labelled rows
  securityNote?: string; // amber/blue callout box (plain text, escaped)
  button?: { label: string; url: string };
  afterButtonNote?: string; // small note under the button
  pasteUrl?: string; // shows "O pega esta URL" block
  footerNote?: string; // overrides default footer note
  isSample?: boolean; // footer hint that it's a sample
}

const S = 'Inter,\'Helvetica Neue\',Helvetica,Arial,sans-serif';
const D = "'Space Grotesk','Helvetica Neue',Helvetica,Arial,sans-serif";

export function renderBranded(input: BrandedEmailInput): { subject: string; html: string; text: string } {
  const role = input.roleTag ?? 'OPERADOR';
  const paras = input.paras ?? [];

  const parasHtml = paras
    .map((p) => `<p style="margin:0 0 14px;font-family:${S};font-size:16px;color:${BRAND.body};line-height:1.6">${escapeHtml(p)}</p>`)
    .join('');

  const detailsHtml = input.details?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 4px;border-collapse:collapse">` +
      input.details
        .map(
          (d) =>
            `<tr><td style="padding:5px 0;font-family:${S};font-size:13px;color:${BRAND.muted};width:42%;vertical-align:top"><b style="color:#64748b">${escapeHtml(d.label)}</b></td>` +
            `<td style="padding:5px 0;font-family:${S};font-size:14px;color:${BRAND.body};vertical-align:top">${escapeHtml(d.value)}</td></tr>`,
        )
        .join('') +
      `</table>`
    : '';

  const securityHtml = input.securityNote
    ? `<tr><td style="padding:0 32px"><div style="padding:12px 16px;background:#eff6ff;border:1px solid #bfdbfe;font-family:${S};font-size:13px;color:#1e40af;line-height:1.55;margin:16px 0"><strong>Seguridad.</strong> ${escapeHtml(input.securityNote)}</div></td></tr>`
    : '';

  const buttonHtml = input.button
    ? `<tr><td align="center" style="padding:26px 32px 8px;text-align:center">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:6px auto 10px">
          <tr><td bgcolor="${BRAND.navy}" style="background:${BRAND.navy}">
            <a href="${escapeHtml(input.button.url)}" style="display:inline-block;font-family:${D};font-size:13px;font-weight:700;color:#ffffff;text-decoration:none;background:${BRAND.navy};padding:14px 30px;letter-spacing:1.4px;text-transform:uppercase">${escapeHtml(input.button.label)} &nbsp;<span style="color:${BRAND.accent}">&rarr;</span></a>
          </td></tr>
        </table>
        ${input.afterButtonNote ? `<p style="margin:12px 0 0;font-family:${S};font-size:12px;color:${BRAND.muted};line-height:1.55;text-align:center">${escapeHtml(input.afterButtonNote)}</p>` : ''}
      </td></tr>`
    : '';

  const pasteHtml = input.pasteUrl
    ? `<tr><td style="padding:6px 32px 0">
        <div style="font-family:${D};font-size:10px;font-weight:700;color:${BRAND.muted};text-transform:uppercase;letter-spacing:0.2em;margin:22px 0 8px">O pega esta URL</div>
        <p style="margin:0 0 8px;font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:12px;color:${BRAND.muted};word-break:break-all;line-height:1.55"><a href="${escapeHtml(input.pasteUrl)}" style="color:${BRAND.navy};text-decoration:underline">${escapeHtml(input.pasteUrl)}</a></p>
      </td></tr>`
    : '';

  const footerLine = input.footerNote ?? 'Todas las acciones quedan registradas en la bitácora de auditoría. Si no reconoces esta actividad, asegura tu cuenta.';
  const sampleHint = input.isSample ? '&nbsp;&middot;&nbsp;<span style="color:#94a3b8">Muestra — no es un correo real</span>' : '';

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="only light"><title>${escapeHtml(input.heading)}</title></head>
<body style="margin:0;padding:0;background:${BRAND.bg};font-family:${S};color:${BRAND.body};-webkit-font-smoothing:antialiased">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" bgcolor="${BRAND.bg}" style="background:${BRAND.bg}">
  <tr><td align="center" style="padding:32px 16px">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="640" style="max-width:640px;width:100%;background:${BRAND.card};border-collapse:collapse">
      <tr><td height="4" bgcolor="${BRAND.accent}" style="background:${BRAND.accent};line-height:4px;font-size:0">&nbsp;</td></tr>
      <tr><td style="background:${BRAND.navy};padding:16px 32px">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td valign="middle" style="vertical-align:middle">
            <table cellpadding="0" cellspacing="0" border="0"><tr>
              <td valign="middle" style="padding-right:12px"><img src="${BRAND.logo}" alt="SISMO911" width="36" height="36" style="display:block;border:0;width:36px;height:36px;border-radius:6px"></td>
              <td valign="middle" style="font-family:${D};font-size:12px;font-weight:700;letter-spacing:0.26em;color:#ffffff;text-transform:uppercase">${escapeHtml(BRAND.wordmark)}</td>
            </tr></table>
          </td>
          <td align="right" valign="middle" style="vertical-align:middle;font-family:${D};font-size:10px;font-weight:700;letter-spacing:0.2em;color:${BRAND.accent};text-transform:uppercase">${escapeHtml(role)}</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:36px 32px 4px">
        <div style="font-family:${D};font-size:11px;font-weight:700;color:${BRAND.eyebrow};text-transform:uppercase;letter-spacing:0.25em;margin:0 0 14px">${escapeHtml(input.eyebrow)}</div>
        <h1 style="margin:0 0 16px;font-family:${D};font-size:32px;font-weight:900;color:${BRAND.navy};letter-spacing:-0.02em;line-height:1.1;text-transform:uppercase">${escapeHtml(input.heading)}</h1>
        ${parasHtml}${detailsHtml}
      </td></tr>
      ${securityHtml}
      ${buttonHtml}
      ${pasteHtml}
      <tr><td style="padding:30px 32px 0">
        <p style="margin:0 0 18px;font-family:${S};font-size:14px;color:${BRAND.body};line-height:1.55">Atentamente,</p>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
          <td valign="top" style="vertical-align:top;padding:0 16px 0 0"><img src="${BRAND.logo}" alt="SISMO911" width="56" height="56" style="display:block;border:0;width:56px;height:56px;border-radius:8px"></td>
          <td valign="middle" style="vertical-align:middle">
            <div style="font-family:${D};font-size:15px;font-weight:700;color:${BRAND.navy};line-height:1.3">Centro de Operaciones SISMO911</div>
            <div style="font-family:${S};font-size:12px;color:${BRAND.muted};letter-spacing:.3px;margin-top:2px">Plataforma Nacional de Emergencia Sísmica</div>
            <div style="font-family:${S};font-size:12px;color:${BRAND.muted};margin-top:6px"><a href="mailto:${BRAND.from}" style="color:${BRAND.navy};text-decoration:underline">${BRAND.from}</a></div>
          </td>
        </tr></table>
        <p style="margin:22px 0 0;font-family:${S};font-size:11px;color:${BRAND.muted};line-height:1.65"><strong style="color:#64748b">Aviso de agente de IA.</strong> SISMO911 es operado por agentes de IA con supervisión humana. Toda acción de riesgo vital requiere la aprobación de un responsable humano.</p>
      </td></tr>
      <tr><td style="padding:34px 32px 0"><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr><td style="border-top:2px solid ${BRAND.accent};line-height:0;font-size:0">&nbsp;</td></tr></table></td></tr>
      <tr><td style="padding:18px 32px 8px">
        <p style="margin:0 0 14px;font-family:${S};font-size:12px;color:${BRAND.muted};line-height:1.65">${escapeHtml(footerLine)}</p>
        <div style="font-family:${D};font-size:11px;font-weight:700;color:#64748b;letter-spacing:0.25em;text-transform:uppercase">SISMO911</div>
        <div style="font-family:${S};font-size:11px;color:${BRAND.muted};margin-top:2px;letter-spacing:.4px">Venezuela &middot; <a href="${BRAND.siteUrl}" style="color:${BRAND.navy};text-decoration:underline">${BRAND.site}</a></div>
      </td></tr>
      <tr><td style="padding:6px 32px 12px"><p style="margin:0;font-family:${S};font-size:10px;color:${BRAND.muted};line-height:1.6"><strong style="color:#64748b">Confidencialidad.</strong> Este correo y sus archivos son confidenciales y están dirigidos únicamente al destinatario. Si lo recibiste por error, notifícalo al remitente y elimínalo.</p></td></tr>
      <tr><td align="center" style="padding:0 32px 28px;text-align:center"><p style="margin:0;font-family:${S};font-size:11px;color:${BRAND.muted};line-height:1.7;text-align:center">Recibes este correo por tu cuenta en el Centro de Operaciones SISMO911.<br><a href="${BRAND.siteUrl}/cuenta" style="color:${BRAND.navy};text-decoration:underline">Preferencias de correo</a>${sampleHint}</p></td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  // Plain-text alternative built from the same pieces.
  const textLines: string[] = [input.eyebrow.toUpperCase(), '', input.heading, '='.repeat(Math.min(input.heading.length, 60)), ''];
  for (const p of paras) textLines.push(p, '');
  for (const d of input.details ?? []) textLines.push(`${d.label}: ${d.value}`);
  if (input.details?.length) textLines.push('');
  if (input.securityNote) textLines.push(`Seguridad. ${input.securityNote}`, '');
  if (input.button) textLines.push(`${input.button.label}: ${input.button.url}`);
  if (input.afterButtonNote) textLines.push(input.afterButtonNote);
  if (input.pasteUrl && !input.button) textLines.push(input.pasteUrl);
  textLines.push('', 'Atentamente,', 'Centro de Operaciones SISMO911', 'Plataforma Nacional de Emergencia Sísmica', BRAND.from, '', `SISMO911 · Venezuela · ${BRAND.siteUrl}`);
  if (input.isSample) textLines.push('Muestra — no es un correo real.');

  return { subject: input.subject, html, text: textLines.filter((l) => l !== undefined).join('\n') };
}
