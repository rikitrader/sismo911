// Live-seismic Telegram bot: pure formatter + command-parser tests.
import { describe, it, expect } from 'vitest';
import {
  parseSismosCommand,
  formatQuake,
  formatQuakeLine,
  formatQuakeList,
  formatThreat,
  formatQuakeAlert,
  quakeEmoji,
  HELP_SISMOS,
} from '../src/telegram-sismos/format';
import { TgUpdate } from '../src/telegram/types';

const quake = {
  id: 'us1',
  mag: 5.8,
  place: '15 km NNE of La Guaira',
  place_es: 'La Guaira',
  depth_km: 24,
  mmi: 5,
  alert: 'orange',
  tsunami: 0,
  time_ms: Date.parse('2026-06-30T20:14:00Z'),
  url: 'https://earthquake.usgs.gov/us1',
};

describe('parseSismosCommand', () => {
  it('maps aliases (ES + EN, with/without slash, mention)', () => {
    expect(parseSismosCommand('/ultimo').kind).toBe('ultimo');
    expect(parseSismosCommand('ultimo').kind).toBe('ultimo');
    expect(parseSismosCommand('/último').kind).toBe('ultimo');
    expect(parseSismosCommand('/last').kind).toBe('ultimo');
    expect(parseSismosCommand('@Sismos_bot /estado').kind).toBe('estado');
    expect(parseSismosCommand('/suscribir').kind).toBe('suscribir');
    expect(parseSismosCommand('/cancelar').kind).toBe('cancelar');
    expect(parseSismosCommand('/help').kind).toBe('ayuda');
  });
  it('greetings + unknown fall back to help', () => {
    expect(parseSismosCommand('hola').kind).toBe('ayuda');
    expect(parseSismosCommand('').kind).toBe('ayuda');
    expect(parseSismosCommand('/xyz').kind).toBe('unknown');
  });
  it('/sismos parses and caps the count', () => {
    expect(parseSismosCommand('/sismos 8').count).toBe(8);
    expect(parseSismosCommand('/sismos 99').count).toBe(20);
    expect(parseSismosCommand('/sismos').count).toBeUndefined();
  });
});

describe('quakeEmoji', () => {
  it('uses the PAGER alert when present, else magnitude', () => {
    expect(quakeEmoji({ alert: 'red' })).toBe('🔴');
    expect(quakeEmoji({ alert: 'orange' })).toBe('🟠');
    expect(quakeEmoji({ mag: 6.1 })).toBe('🔴');
    expect(quakeEmoji({ mag: 4.2 })).toBe('🟡');
    expect(quakeEmoji({ mag: 2.0 })).toBe('⚪');
  });
});

describe('formatQuake', () => {
  const out = formatQuake(quake);
  it('shows magnitude, place, depth, MMI, alert, time, link', () => {
    expect(out).toContain('Sismo M5.8 — La Guaira');
    expect(out).toContain('prof. 24 km');
    expect(out).toContain('MMI 5');
    expect(out).toContain('alerta naranja');
    expect(out).toContain('2026-06-30 20:14 UTC');
    expect(out).toContain('https://earthquake.usgs.gov/us1');
    expect(out.startsWith('🟠')).toBe(true);
  });
  it('adds a tsunami warning when flagged', () => {
    expect(formatQuake({ ...quake, tsunami: 1 })).toContain('tsunami');
  });
});

describe('formatQuakeList / line', () => {
  it('lists recent quakes', () => {
    const out = formatQuakeList([quake, { ...quake, id: 'us2', mag: 3.1, place_es: 'Caracas' }]);
    expect(out).toContain('Últimos 2 sismos');
    expect(out).toContain('M5.8 — La Guaira');
    expect(out).toContain('M3.1 — Caracas');
  });
  it('handles an empty registry', () => {
    expect(formatQuakeList([])).toMatch(/No hay sismos recientes/);
  });
  it('one-liner includes depth', () => {
    expect(formatQuakeLine(quake)).toContain('24 km');
  });
});

describe('formatThreat', () => {
  it('renders the estado + driving quake', () => {
    const threat = { level: 3, label: 'Elevado', score: 72, reason: 'M5.8 reciente', max_mag_48h: 5.8, recent_6h: 4, sources: ['USGS', 'FUNVISIS'] };
    const out = formatThreat(threat, quake);
    expect(out).toContain('Estado sísmico: Elevado');
    expect(out).toContain('nivel 3/4');
    expect(out).toContain('índice 72/100');
    expect(out).toContain('Máx. 48h: M5.8');
    expect(out).toContain('Fuentes: USGS, FUNVISIS');
    expect(out).toContain('Último sismo:');
  });
});

describe('TgUpdate accepts channel + membership updates', () => {
  it('parses a channel_post', () => {
    const r = TgUpdate.safeParse({ update_id: 1, channel_post: { message_id: 1, chat: { id: -100123, type: 'channel' }, text: '/ultimo' } });
    expect(r.success).toBe(true);
    expect(r.success && r.data.channel_post?.text).toBe('/ultimo');
  });
  it('parses my_chat_member (bot promoted to admin in a channel)', () => {
    const r = TgUpdate.safeParse({ update_id: 2, my_chat_member: { chat: { id: -100123, type: 'channel' }, new_chat_member: { status: 'administrator' } } });
    expect(r.success).toBe(true);
    expect(r.success && r.data.my_chat_member?.new_chat_member?.status).toBe('administrator');
  });
});

describe('formatQuakeAlert + help', () => {
  it('alert leads with the siren + guidance link', () => {
    const a = formatQuakeAlert(quake);
    expect(a).toMatch(/ALERTA SÍSMICA/);
    expect(a).toContain('Sismo M5.8 — La Guaira');
    expect(a).toContain('/guia');
  });
  it('help lists every command', () => {
    for (const c of ['/ultimo', '/sismos', '/estado', '/suscribir', '/cancelar', '/ayuda']) {
      expect(HELP_SISMOS).toContain(c);
    }
  });
});
