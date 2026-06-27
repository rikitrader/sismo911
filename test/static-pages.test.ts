import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import worker, { PUBLIC_COMMAND_ASSETS } from '../src/index';

describe('public command surfaces', () => {
  it('serves clean command URLs from explicit HTML assets', async () => {
    for (const [path, assetPath] of Object.entries(PUBLIC_COMMAND_ASSETS)) {
      const requested: string[] = [];
      const env = {
        ASSETS: {
          fetch: async (request: Request) => {
            requested.push(new URL(request.url).pathname);
            return new Response('<!doctype html><title>SISMO911</title>', {
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          },
        },
      } as any;

      const res = await worker.fetch(new Request(`https://sismo911.test${path}`), env);

      expect(res.status).toBe(200);
      expect(requested).toEqual([assetPath]);
      // Command shells are served directly from Assets with brief edge caching
      // (PR #269/#265) — live data still arrives via the JSON APIs.
      expect(res.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=300');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    }
  });

  it('falls back from a clean URL to the matching html asset when needed', async () => {
    const requested: string[] = [];
    const env = {
      ASSETS: {
        fetch: async (request: Request) => {
          const path = new URL(request.url).pathname;
          requested.push(path);
          if (path === '/contacto.html') {
            return new Response('<!doctype html><title>Contacto</title>', {
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          return new Response('not found', { status: 404 });
        },
      },
    } as any;

    const res = await worker.fetch(new Request('https://sismo911.test/contacto'), env);

    expect(res.status).toBe(200);
    expect(requested).toEqual(['/contacto', '/contacto.html']);
    expect(await res.text()).toContain('Contacto');
  });

  it('mounts the public COP layer and sitrep APIs at the Worker entrypoint', async () => {
    const emptyRows = { results: [] };
    const env = {
      DB: {
        prepare: () => ({
          bind() { return this; },
          all: async () => emptyRows,
          first: async () => ({ n: 0, total: 0, critical: 0, resources: 0, trapped: 0, quarantine: 0, expired: 0, within30: 0, total_lots: 0 }),
          run: async () => ({ meta: { changes: 0 } }),
        }),
      },
      ASSETS: {
        fetch: async () => new Response('[]', { headers: { 'content-type': 'application/json' } }),
      },
    } as any;

    const catalog = await worker.fetch(new Request('https://sismo911.test/api/layers/catalog'), env);
    expect(catalog.status).toBe(200);
    expect(catalog.headers.get('cache-control')).toContain('max-age=300');
    const catalogJson = await catalog.json() as any;
    expect(catalogJson.scope).toBe('public_cop_layer_catalog');
    expect(catalogJson.layers.map((l: any) => l.id)).toContain('satellite_damage');

    const geoseismic = await worker.fetch(new Request('https://sismo911.test/api/layers/geoseismic?include=events,impact,satellite_damage&limit=20'), env);
    expect(geoseismic.status).toBe(200);
    const geoseismicJson = await geoseismic.json() as any;
    expect(geoseismicJson.type).toBe('FeatureCollection');

    const sitrep = await worker.fetch(new Request('https://sismo911.test/api/sitrep'), env);
    expect(sitrep.status).toBe(200);
    expect(sitrep.headers.get('cache-control')).toContain('max-age=30');
    const sitrepJson = await sitrep.json() as any;
    expect(sitrepJson.scope).toBe('public_non_pii');
    expect(sitrepJson.esf.framework).toBe('FEMA_ESF_style_operational_matrix');
  });

  it('ships a real indexed command dashboard, not the retired static demo', () => {
    const dashboard = readFileSync('public/dashboard.html', 'utf8');
    const shell = readFileSync('public/app-shell.js', 'utf8');
    const robots = readFileSync('public/robots.txt', 'utf8');
    const sitemap = readFileSync('public/sitemap.xml', 'utf8');

    expect(dashboard).toContain('Panel Nacional de Comando');
    expect(dashboard).toContain('/api/sitrep');
    expect(dashboard).toContain('/api/sitrep/ics-209');
    expect(dashboard).toContain('/api/sitrep/cap');
    expect(dashboard).toContain('/api/sitrep/timeline?limit=40');
    expect(dashboard).toContain('Common Operating Picture');
    expect(dashboard).toContain('Abrir ICS-209-Lite');
    expect(dashboard).toContain('Abrir CAP XML');
    expect(dashboard).toContain('Matriz ESF FEMA');
    expect(dashboard).toContain('Matriz de brechas ESF-7');
    expect(dashboard).toContain('Catálogo de capas COP');
    expect(dashboard).toContain('Timeline operacional');
    expect(dashboard).toContain('renderTimeline');
    expect(dashboard).toContain('renderEsf');
    expect(dashboard).toContain('renderGaps');
    expect(dashboard).toContain('renderCatalog');
    expect(dashboard).toContain('/api/events?limit=300');
    expect(dashboard).toContain('/api/acopio/dashboard');
    expect(dashboard).toContain('/api/acopio/gaps');
    expect(dashboard).toContain('/api/layers/catalog');
    expect(dashboard).toContain('/api/layers/geoseismic?include=impact,satellite_damage&impactMinMag=4&limit=220');
    expect(dashboard).toContain('/api/layers/operational?include=acopio,needs,shipments,resources');
    expect(dashboard).toContain('/api/layers/humanitarian?include=signals&limit=300');
    expect(dashboard).toContain('/api/layers/state-posture?limit=25');
    expect(dashboard).toContain('/api/layers/lifelines?include=health,comms,resources,acopio&limit=800');
    expect(dashboard).toContain('/api/humanitarian/dashboard');
    expect(dashboard).toContain('Impacto sísmico estimado');
    expect(dashboard).toContain('Daño satelital IA');
    expect(dashboard).toContain('Señales humanitarias');
    expect(dashboard).toContain('Postura por estado');
    expect(dashboard).toContain('Lifelines ESF');
    expect(dashboard).toContain('Necesidades logísticas');
    expect(dashboard).toContain('Envíos activos');
    expect(dashboard).toContain('Recursos públicos');
    expect(dashboard).toContain('Humanitario');
    expect(dashboard).toContain('Geosísmico 24h');
    expect(dashboard).toContain('Logística crítica');
    expect(dashboard).toContain('Satélite IA');
    expect(dashboard).not.toContain('noindex');
    expect(dashboard).not.toContain('href="#"');
    expect(shell).toContain("href: '/dashboard'");
    expect(shell).toContain("href: '/geosismico'");
    expect(robots).not.toContain('dashboard-static');
    expect(sitemap).toContain('https://sismo911.com/dashboard');
    expect(existsSync('public/dashboard-static.html')).toBe(false);
  });

  it('does not show fabricated fallback quakes on the public terremotos page', () => {
    // index.html was renamed to terremotos.html (PR #271) so /terremotos serves it.
    const page = readFileSync('public/terremotos.html', 'utf8');

    expect(page).toContain('/api/events?limit=300');
    expect(page).toContain('href="/alertas"');
    expect(page).toContain('Sin conexión al feed de eventos');
    expect(page).toContain('viewport-fit=cover');
    expect(page).toContain('overflow-x: hidden');
    expect(page).toContain('touch-action: manipulation');
    expect(page).toContain('https://earthquake.usgs.gov/earthquakes/map/');
    expect(page).not.toContain('FALLBACK');
    expect(page).not.toContain('Datos de muestra');
    expect(page).not.toContain('href="#"');
  });

  it('wires the public map to operational logistics GeoJSON layers', () => {
    const page = readFileSync('public/mapa.html', 'utf8');

    expect(page).toContain('/api/layers/geoseismic?include=impact,satellite_damage&impactMinMag=4&limit=220');
    expect(page).toContain('/api/layers/catalog');
    expect(page).toContain('/api/layers/operational?include=acopio,needs,shipments,resources');
    expect(page).toContain('/api/layers/humanitarian?include=signals&limit=300');
    expect(page).toContain('/api/layers/state-posture?limit=25');
    expect(page).toContain('/api/layers/lifelines?include=health,comms,resources,acopio&limit=800');
    expect(page).toContain('Impacto sísmico estimado');
    expect(page).toContain('Daño satelital IA');
    expect(page).toContain('Señales humanitarias');
    expect(page).toContain('Postura por estado');
    expect(page).toContain('Lifelines ESF');
    expect(page).toContain('Capas COP');
    expect(page).toContain('Centros de acopio');
    expect(page).toContain('Necesidades logísticas');
    expect(page).toContain('Envíos activos');
    expect(page).toContain('Recursos públicos');
  });

  it('publishes a public COP layers catalog page', () => {
    const page = readFileSync('public/layers.html', 'utf8');
    const sitemap = readFileSync('public/sitemap.xml', 'utf8');
    const sw = readFileSync('public/sw.js', 'utf8');
    const shell = readFileSync('public/app-shell.js', 'utf8');

    expect(page).toContain('Capas COP');
    expect(page).toContain('/api/layers/catalog');
    expect(page).toContain('privacy labels');
    expect(page).toContain('Geosísmicas');
    expect(page).toContain('Humanitarias');
    expect(page).toContain('Lifelines');
    expect(page).toContain('Abrir API');
    expect(page).toContain('/geosismico');
    expect(page).toContain('/humanitario');
    expect(page).toContain('/mapa');
    expect(sitemap).toContain('https://sismo911.com/layers');
    expect(sw).toContain('/layers.html');
    expect(shell).toContain("href: '/layers'");
    expect(shell).toContain('overflow-x:hidden');
  });

  it('publishes a public satellite intelligence page for the PyTorch damage pipeline', () => {
    const page = readFileSync('public/satellite.html', 'utf8');
    const sitemap = readFileSync('public/sitemap.xml', 'utf8');
    const sw = readFileSync('public/sw.js', 'utf8');
    const shell = readFileSync('public/app-shell.js', 'utf8');

    expect(page).toContain('Satélite IA');
    expect(page).toContain('/api/sat/config');
    expect(page).toContain('/api/sat/damage');
    expect(page).toContain('/api/sat/pytorch-results');
    expect(page).toContain('Daño satelital IA');
    expect(page).toContain('Detecciones recientes');
    expect(page).toContain('Fuentes de imagery');
    expect(page).toContain('Pipeline externo');
    expect(page).toContain('unverified');
    expect(sitemap).toContain('https://sismo911.com/satellite');
    expect(sw).toContain('/satellite.html');
    expect(shell).toContain("href: '/satellite'");
  });

  it('exposes lot-level expiry and bin controls in the logistics console', () => {
    const page = readFileSync('public/logistica.html', 'utf8');
    const sitemap = readFileSync('public/sitemap.xml', 'utf8');

    expect(page).toContain('/api/acopio/lots');
    expect(page).toContain('/api/acopio/gaps');
    expect(page).toContain('/api/acopio/gaps/by-state');
    expect(page).toContain('Brechas ESF-7');
    expect(page).toContain('Matriz nacional de brechas ESF-7');
    expect(page).toContain('Brechas por estado');
    expect(page).toContain('renderGaps');
    expect(page).toContain('Registrar lote / vencimiento');
    expect(page).toContain('Bin / ubicación interna');
    expect(page).toContain('Lotes en riesgo');
    expect(page).toContain('expiration_date');
    expect(page).toContain('index,follow');
    expect(page).not.toContain('noindex');
    expect(page).toContain('https://sismo911.com/logistica');
    expect(sitemap).toContain('https://sismo911.com/logistica');
  });

  it('publishes the logistics operations command page without hiding it from search', () => {
    const page = readFileSync('public/operaciones.html', 'utf8');
    const sitemap = readFileSync('public/sitemap.xml', 'utf8');
    const shell = readFileSync('public/app-shell.js', 'utf8');
    const sw = readFileSync('public/sw.js', 'utf8');

    expect(PUBLIC_COMMAND_ASSETS['/operaciones']).toBe('/operaciones');
    expect(page).toContain('Centro de Operaciones Logísticas');
    expect(page).toContain('index,follow');
    expect(page).toContain('https://sismo911.com/operaciones');
    expect(page).not.toContain('noindex');
    expect(page).not.toContain('href="#"');
    expect(sitemap).toContain('https://sismo911.com/operaciones');
    expect(shell).toContain("href: '/operaciones'");
    expect(sw).toContain('/operaciones.html');
  });

  it('exposes non-biometric missing/found same-photo review in the operator case console', () => {
    const page = readFileSync('public/admin-casos.html', 'utf8');

    expect(page).toContain("api('persons/photo-review/candidates')");
    expect(page).toContain('Revisión de fotos: buscadas / localizadas');
    expect(page).toContain('No es reconocimiento facial ni identificación biométrica');
    expect(page).toContain('Control no biométrico');
    expect(page).toContain('loadPhotoReviewCount');
    expect(page).toContain('photoReviewBanner');
    expect(page).toContain('openPhotoReview');
    expect(page).toContain('same-photo');
  });

  it('lists the public humanitarian and geoseismic operating pages in the sitemap', () => {
    const sitemap = readFileSync('public/sitemap.xml', 'utf8');
    const index = readFileSync('public/sitemap_index.xml', 'utf8');
    const robots = readFileSync('public/robots.txt', 'utf8');
    const shell = readFileSync('public/app-shell.js', 'utf8');
    const sw = readFileSync('public/sw.js', 'utf8');
    const humanitarian = readFileSync('public/humanitario.html', 'utf8');
    const geosismic = readFileSync('public/geosismico.html', 'utf8');

    expect(sitemap).toContain('https://sismo911.com/dashboard');
    expect(sitemap).toContain('https://sismo911.com/mapa');
    expect(sitemap).toContain('https://sismo911.com/geosismico');
    expect(sitemap).toContain('https://sismo911.com/estados');
    expect(sitemap).toContain('https://sismo911.com/acopio');
    expect(sitemap).toContain('https://sismo911.com/humanitario');
    expect(sitemap).toContain('https://sismo911.com/red-ayuda');
    expect(shell).toContain("href: '/humanitario'");
    expect(shell).toContain('Centro Geosísmico');
    expect(sw).toContain('/humanitario.html');
    expect(sw).toContain('/geosismico.html');
    expect(humanitarian).toContain('Centro Humanitario');
    expect(humanitarian).toContain('/api/humanitarian/dashboard');
    expect(humanitarian).toContain('/api/layers/humanitarian?include=signals&limit=300');
    expect(humanitarian).toContain('/api/layers/state-posture?limit=25');
    expect(humanitarian).toContain('/api/layers/lifelines?include=health,comms,resources,acopio&limit=800');
    expect(humanitarian).toContain('sin datos personales');
    expect(humanitarian).not.toContain('noindex');
    expect(humanitarian).not.toContain('href="#"');
    expect(geosismic).toContain('Centro Geosísmico');
    expect(geosismic).toContain('/api/sitrep');
    expect(geosismic).toContain('/api/events?limit=300');
    expect(geosismic).toContain('/api/layers/geoseismic?include=events,impact,satellite_damage&impactMinMag=4&limit=220');
    expect(geosismic).toContain('/api/sitrep/timeline?limit=40');
    expect(geosismic).toContain('/api/layers/catalog');
    expect(geosismic).toContain('Impacto sísmico estimado');
    expect(geosismic).toContain('Daño satelital IA');
    expect(geosismic).not.toContain('noindex');
    expect(geosismic).not.toContain('href="#"');
    expect(index).toContain('https://sismo911.com/sitemap-estados.xml');
    expect(robots).toContain('https://sismo911.com/sitemap-estados.xml');
  });
});
