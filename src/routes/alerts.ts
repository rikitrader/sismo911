import { Hono } from 'hono';
import type { Env } from '../types';

export const alerts = new Hono<{ Bindings: Env }>();

// GET /api/alerts — multi-agency. USGS tsunami/significant (GLOBAL, covers VE);
// NWS active tsunami (US + Caribbean); OpenFEMA declarations (US ONLY — flagged).
alerts.get('/', async (c) => {
  const out: any[] = [];

  // 1) USGS significant / tsunami-flagged — from our mirror (global coverage)
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, mag, place, time_ms, tsunami, url FROM events
       WHERE tsunami = 1 OR mag >= 6 ORDER BY time_ms DESC LIMIT 20`
    ).all<any>();
    for (const e of results ?? []) out.push({
      source: 'usgs', coverage: 'global', kind: e.tsunami ? 'tsunami' : 'earthquake',
      title: `M ${e.mag} · ${e.place}`,
      severity: e.tsunami ? 'critical' : e.mag >= 7 ? 'critical' : 'warning',
      time_ms: e.time_ms, url: e.url,
    });
  } catch { /* ignore */ }

  // 2) NWS active tsunami alerts (US + Caribbean territories)
  try {
    const r = await fetch(
      'https://api.weather.gov/alerts/active?event=Tsunami%20Warning,Tsunami%20Watch,Tsunami%20Advisory',
      { headers: { 'User-Agent': 'SISMO911 (emergency monitoring)', Accept: 'application/geo+json' }, cf: { cacheTtl: 120 } }
    );
    if (r.ok) {
      const j: any = await r.json();
      for (const f of (j.features ?? []).slice(0, 20)) out.push({
        source: 'nws', coverage: 'EE.UU./Caribe', kind: 'tsunami',
        title: f.properties?.headline || f.properties?.event, severity: 'critical',
        time_ms: Date.parse(f.properties?.sent || '') || null, url: f.properties?.['@id'] ?? null,
      });
    }
  } catch { /* ignore */ }

  // 3) OpenFEMA recent disaster declarations (US ONLY — labeled)
  try {
    const r = await fetch(
      'https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?$orderby=declarationDate%20desc&$top=8&$format=json',
      { cf: { cacheTtl: 3600 } }
    );
    if (r.ok) {
      const j: any = await r.json();
      for (const d of j.DisasterDeclarationsSummaries ?? []) out.push({
        source: 'fema', coverage: 'EE.UU. solamente', kind: 'declaration',
        title: `${d.declarationTitle} (${d.state})`, severity: 'advisory',
        time_ms: Date.parse(d.declarationDate) || null, url: null,
      });
    }
  } catch { /* ignore */ }

  out.sort((a, b) => (b.time_ms ?? 0) - (a.time_ms ?? 0));
  return c.json({ updated_ms: Date.now(), count: out.length, alerts: out });
});
