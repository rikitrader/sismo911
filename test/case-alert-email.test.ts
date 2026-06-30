import { describe, it, expect } from 'vitest';
import { subscribeVerifyEmail, subscribeConfirmedEmail, caseChangeAlertEmail } from '../src/lib/email';

describe('case-alert email templates', () => {
  it('verify email embeds the confirm link in html + text and a clear subject', () => {
    const m = subscribeVerifyEmail({ caseName: 'Juana Pérez', verifyUrl: 'https://sismo911.com/s/verify/TOKEN123', caseUrl: 'https://sismo911.com/familia' });
    expect(m.subject).toMatch(/Confirma/i);
    expect(m.html).toContain('https://sismo911.com/s/verify/TOKEN123');
    expect(m.text).toContain('https://sismo911.com/s/verify/TOKEN123');
    expect(m.html).toContain('Juana Pérez');
  });

  it('confirmed email carries the one-click unsubscribe link', () => {
    const m = subscribeConfirmedEmail({ caseName: 'Juana Pérez', caseUrl: 'https://sismo911.com/familia', unsubUrl: 'https://sismo911.com/s/unsub/UNSUB1' });
    expect(m.html).toContain('https://sismo911.com/s/unsub/UNSUB1');
    expect(m.text).toContain('https://sismo911.com/s/unsub/UNSUB1');
  });

  it('change-alert renders the summary, a from→to change row, and unsubscribe', () => {
    const m = caseChangeAlertEmail({
      caseName: 'Juana Pérez',
      statusLabel: 'Apareció / a salvo',
      summary: 'El estado del caso cambió a "a salvo".',
      changes: [{ label: 'Estado', from: 'Sin contacto', to: 'Apareció / a salvo' }],
      caseUrl: 'https://sismo911.com/familia',
      unsubUrl: 'https://sismo911.com/s/unsub/UNSUB1',
    });
    expect(m.subject).toContain('Apareció / a salvo');
    expect(m.html).toContain('Sin contacto');
    expect(m.html).toContain('Apareció / a salvo');
    expect(m.html).toContain('https://sismo911.com/s/unsub/UNSUB1');
    expect(m.text).toContain('Estado: Sin contacto → Apareció / a salvo');
  });

  it('escapes HTML in case name + summary (no injection)', () => {
    const m = caseChangeAlertEmail({
      caseName: '<script>x</script>',
      statusLabel: 'X',
      summary: 'a <b>b</b>',
      changes: [],
      caseUrl: 'u', unsubUrl: 'v',
    });
    expect(m.html).not.toContain('<script>x</script>');
    expect(m.html).toContain('&lt;script&gt;');
  });
});
