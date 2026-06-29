import { describe, it, expect } from 'vitest';
import { renderBranded, escapeHtml } from '../src/lib/email-brand';
import { verifyEmail, welcomeEmail, donationReceiptEmail, operationalAlert } from '../src/lib/email-catalog';
import { CATALOG, sampleById } from '../src/lib/email-samples';

describe('renderBranded shell', () => {
  it('carries SISMO911 branding + escapes injection', () => {
    const r = renderBranded({ subject: 's', eyebrow: 'e', heading: 'H', paras: ['<script>x</script>'], button: { label: 'Go', url: 'https://x?a=1&b=2' } });
    expect(r.html).toContain('SISMO911');
    expect(r.html).toContain('&lt;script&gt;');         // body escaped
    expect(r.html).not.toContain('<script>x</script>');
    expect(r.html).toContain('a=1&amp;b=2');            // href escaped
    expect(r.text.length).toBeGreaterThan(0);
  });
  it('escapeHtml handles all significant chars', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('dedicated builders', () => {
  it('verifyEmail (AUTH-01) subject + button', () => {
    const r = verifyEmail({ name: 'Ricardo', url: 'https://sismo911.com/v?token=abc' });
    expect(r.subject).toBe('Verifica tu correo de SISMO911');
    expect(r.html).toContain('Verificar correo');
    expect(r.html).toContain('token=abc');
  });
  it('welcomeEmail (AUTH-02) is distinct from verify', () => {
    expect(welcomeEmail({ url: 'https://sismo911.com/cuenta' }).subject).toContain('tu cuenta está activa');
  });
  it('donationReceiptEmail (FIN-01) shows amount + ref', () => {
    const r = donationReceiptEmail({ amount: '$50,00', when: '28/06/2026', ref: 'DON-1', method: 'Tarjeta' });
    expect(r.html).toContain('$50,00');
    expect(r.html).toContain('DON-1');
  });
  it('operationalAlert renders any workflow', () => {
    expect(operationalAlert({ subject: 'x', eyebrow: 'y', heading: 'Z' }).html).toContain('SISMO911');
  });
});

describe('77-email sample catalog (source of truth)', () => {
  it('has exactly 77 entries with unique IDs', () => {
    expect(CATALOG.length).toBe(77);
    expect(new Set(CATALOG.map((s) => s.id)).size).toBe(77);
  });
  it('every sample renders a non-empty branded subject/html/text', () => {
    for (const s of CATALOG) {
      const r = s.render();
      expect(r.subject, s.id).toBeTruthy();
      expect(r.html, s.id).toContain('SISMO911');
      expect(r.text.length, s.id).toBeGreaterThan(0);
      expect(r.html, s.id).toContain('Muestra'); // every preview is flagged as a sample
    }
  });
  it('covers all 14 departments', () => {
    expect(new Set(CATALOG.map((s) => s.dept)).size).toBe(14);
  });
  it('sampleById is case-insensitive and returns undefined for unknown', () => {
    expect(sampleById('auth-01')?.id).toBe('AUTH-01');
    expect(sampleById('nope')).toBeUndefined();
  });
});
