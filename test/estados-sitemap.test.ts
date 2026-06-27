import { describe, expect, it } from 'vitest';
import { estados } from '../src/routes/estados';
import { ESTADOS } from '../src/data/estados';

describe('state geoseismic sitemap', () => {
  it('lists every registered state GIS page', async () => {
    const res = await estados.request('/sitemap-estados.xml');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    const xml = await res.text();
    expect(xml).toContain('<urlset');
    for (const st of ESTADOS) {
      expect(xml).toContain(`https://sismo911.com/estado/${st.slug}`);
    }
    expect((xml.match(/<url>/g) ?? []).length).toBe(ESTADOS.length);
  });
});
