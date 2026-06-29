import { Hono } from 'hono';
import type { Env } from '../types';
import { sendEmail } from '../lib/email';
import { CATALOG, sampleById } from '../lib/email-samples';

// Transactional-email preview + connectivity test. Token-gated (NOTIFY_TOKEN
// secret, x-notify-token header) so the whole 77-email catalog can be previewed
// and a live sample delivered, WITHOUT exposing an anonymous send vector. The
// global gate lets requests reach here (/api/notify is on the public allow-list);
// the token check below is the real auth, mirroring /api/notify/test in AIDRC.
export const notify = new Hono<{ Bindings: Env }>();

function authed(c: any): boolean {
  const expected = c.env.NOTIFY_TOKEN;
  return !!expected && c.req.header('x-notify-token') === expected;
}

// GET /api/notify/preview — JSON index of every catalogued email (id, dept, name,
// subject). No token needed for the index (non-sensitive metadata), but rendering
// and sending below ARE token-gated.
notify.get('/preview', (c) => {
  const items = CATALOG.map((s) => ({ id: s.id, dept: s.dept, name: s.name, subject: s.render().subject }));
  return c.json({ count: items.length, items });
});

// GET /api/notify/preview/:id — render one sample as HTML (open in a browser).
// Token-gated to avoid serving brand assets / copy to anonymous callers.
notify.get('/preview/:id', (c) => {
  if (!c.env.NOTIFY_TOKEN) return c.json({ error: 'preview disabled (NOTIFY_TOKEN not set)' }, 503);
  if (!authed(c)) return c.json({ error: 'unauthorized', hint: 'send x-notify-token' }, 401);
  const s = sampleById(c.req.param('id'));
  if (!s) return c.json({ error: 'unknown id', available: CATALOG.map((x) => x.id) }, 404);
  const fmt = c.req.query('format');
  if (fmt === 'text') return c.text(s.render().text);
  if (fmt === 'json') return c.json(s.render());
  return c.html(s.render().html);
});

// POST /api/notify/test  { to, id? } — deliver a live sample (or a connectivity
// check when id is omitted). Verifies the Worker -> Email path end-to-end.
notify.post('/test', async (c) => {
  if (!c.env.NOTIFY_TOKEN) return c.json({ error: 'email test disabled (NOTIFY_TOKEN not set)' }, 503);
  if (!authed(c)) return c.json({ error: 'unauthorized' }, 401);
  const b = await c.req.json().catch(() => null);
  const to = (b?.to || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return c.json({ error: 'invalid_to' }, 400);
  const id = b?.id ? String(b.id) : '';
  let mail;
  if (id) {
    const s = sampleById(id);
    if (!s) return c.json({ error: 'unknown id', available: CATALOG.map((x) => x.id) }, 400);
    mail = s.render();
  } else {
    // Connectivity check via the first AUTH sample (verify).
    mail = sampleById('AUTH-01')!.render();
  }
  const ok = await sendEmail(c.env, to, mail);
  return c.json({ ok, delivered_to: to, id: id || 'AUTH-01' }, ok ? 200 : 502);
});
