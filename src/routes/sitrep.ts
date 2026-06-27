import { Hono } from 'hono';
import type { Env } from '../types';
import { scoreThreat } from '../lib/threat';
import { adapterStatus } from '../adapters/social';

export const sitrep = new Hono<{ Bindings: Env }>();

const emptyRows = { results: [] as any[] };
const DAY_MS = 86_400_000;

const rows = (r: any) => (r?.results ?? []) as any[];
const sum = (xs: any[], pred = (_: any) => true) => xs.filter(pred).reduce((a, x) => a + Number(x.n ?? 0), 0);
const str = (v: unknown, max = 120) => v == null ? null : String(v).trim().slice(0, max) || null;
const severityRank: Record<string, number> = { normal: 0, watch: 1, elevated: 2, emergency: 3 };
const rankStatus = (score: number) => score >= 12 ? 'emergency' : score >= 5 ? 'elevated' : score >= 1 ? 'watch' : 'normal';

function level(label: string, reasons: string[]) {
  return { label, rank: severityRank[label] ?? 0, reasons };
}

function pickReadiness(parts: ReturnType<typeof level>[]) {
  return parts.reduce((max, p) => (p.rank > max.rank ? p : max), level('normal', ['Sin señales críticas agregadas.']));
}

export function buildEsfStatus(s: any) {
  const criticalNeeds = Number(s.logistics?.needs?.critical ?? 0);
  const openNeeds = Number(s.logistics?.needs?.open ?? 0);
  const lotsAtRisk = Number(s.logistics?.lots?.at_risk ?? 0);
  const inTransit = Number(s.logistics?.shipments?.in_transit ?? 0);
  const delivered = Number(s.logistics?.shipments?.delivered ?? 0);
  const unresolvedSos = Number(s.humanitarian?.sos?.unresolved ?? 0);
  const needHelp = Number(s.humanitarian?.checkins?.need_help ?? 0);
  const resourcesCritical = Number(s.humanitarian?.resources?.low ?? 0) + Number(s.humanitarian?.resources?.depleted ?? 0);
  const fullShelters = Number(s.shelters?.full ?? 0);
  const closedShelters = Number(s.shelters?.closed ?? 0);
  const trapped = Number(s.damage?.reports?.trapped ?? 0);
  const criticalReports = Number(s.damage?.reports?.critical ?? 0);
  const satSevere = Number(s.damage?.satellite?.severe ?? 0);
  const satUnverified = Number(s.damage?.satellite?.unverified ?? 0);
  const feedGap = Math.max(0, Number(s.feeds?.social_configured ?? 0) - Number(s.feeds?.social_live ?? 0));
  const ingestSources = Number(s.feeds?.ingest?.length ?? 0);
  const maxMag = Number(s.geoseismic?.maxMag24h ?? 0);

  const item = (code: string, title: string, score: number, metrics: Record<string, number>, actions: string[]) => ({
    code,
    title,
    status: rankStatus(score),
    score,
    metrics,
    actions: actions.filter(Boolean).slice(0, 3),
  });

  const esf = [
    item('ESF-1', 'Transportation', openNeeds + inTransit > 0 ? Math.min(20, openNeeds + inTransit * 2) : 0, { open_needs: openNeeds, in_transit: inTransit, delivered }, [
      inTransit > 0 ? 'Track active relief movements to destination.' : '',
      openNeeds > 0 ? 'Identify transport capacity for open logistics needs.' : '',
    ]),
    item('ESF-2', 'Communications', feedGap * 3 + (ingestSources === 0 ? 4 : 0), { ingest_sources: ingestSources, feed_gap: feedGap }, [
      feedGap > 0 ? 'Restore configured feeds that are not live.' : '',
      ingestSources === 0 ? 'Confirm at least one live ingest source.' : '',
    ]),
    item('ESF-6', 'Mass Care', fullShelters * 3 + closedShelters * 4 + needHelp * 2 + unresolvedSos, { full_shelters: fullShelters, closed_shelters: closedShelters, need_help: needHelp, unresolved_sos: unresolvedSos }, [
      fullShelters + closedShelters > 0 ? 'Publish alternate shelter capacity.' : '',
      needHelp + unresolvedSos > 0 ? 'Coordinate welfare checks and family assistance.' : '',
    ]),
    item('ESF-7', 'Logistics', criticalNeeds * 5 + lotsAtRisk * 2 + Math.max(0, openNeeds - delivered), { critical_needs: criticalNeeds, open_needs: openNeeds, lots_at_risk: lotsAtRisk, delivered }, [
      criticalNeeds > 0 ? 'Match priority-1 needs against inventory.' : '',
      lotsAtRisk > 0 ? 'Hold or inspect expired/quarantine lots before dispatch.' : '',
    ]),
    item('ESF-8', 'Public Health', resourcesCritical * 2 + fullShelters + needHelp, { critical_resources: resourcesCritical, full_shelters: fullShelters, need_help: needHelp }, [
      resourcesCritical > 0 ? 'Replenish low/depleted public health resources.' : '',
      fullShelters > 0 ? 'Assess shelter health load and sanitation risk.' : '',
    ]),
    item('ESF-9', 'Search and Rescue', trapped * 7 + unresolvedSos * 4 + satSevere * 3, { trapped_reports: trapped, unresolved_sos: unresolvedSos, satellite_severe: satSevere }, [
      trapped > 0 ? 'Prioritize structural-collapse rescue reports.' : '',
      satSevere > 0 ? 'Task field verification for severe satellite damage.' : '',
    ]),
    item('ESF-14', 'Damage Assessment', criticalReports * 3 + satSevere * 4 + satUnverified, { critical_reports: criticalReports, satellite_severe: satSevere, satellite_unverified: satUnverified }, [
      satUnverified > 0 ? 'Verify unconfirmed satellite/PyTorch damage assessments.' : '',
      criticalReports > 0 ? 'Reconcile citizen damage reports with field assessment.' : '',
    ]),
    item('ESF-15', 'External Affairs', (maxMag >= 4 ? 3 : 0) + (feedGap > 0 ? 2 : 0), { max_mag_24h: Number(maxMag.toFixed(1)), feed_gap: feedGap }, [
      maxMag >= 4 ? 'Maintain public geoseismic updates and rumor control.' : '',
      feedGap > 0 ? 'Label unavailable integrations honestly in public products.' : '',
    ]),
  ];

  return {
    scope: 'public_non_pii',
    framework: 'FEMA_ESF_style_operational_matrix',
    generated_ms: Number(s.generated_ms ?? Date.now()),
    summary: {
      emergency: esf.filter((x) => x.status === 'emergency').length,
      elevated: esf.filter((x) => x.status === 'elevated').length,
      watch: esf.filter((x) => x.status === 'watch').length,
      normal: esf.filter((x) => x.status === 'normal').length,
    },
    functions: esf,
  };
}

export async function buildSitrep(env: Env, now = Date.now()) {
  const [
    latestEvents,
    reportStats,
    reportSeverity,
    checkins,
    sos,
    resources,
    shelters,
    inv,
    needs,
    ships,
    custody,
    expiry,
    satDamage,
    ingest,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT id, mag, place, place_es, time_ms, lat, lon, depth_km, mmi, alert, tsunami, url
       FROM events ORDER BY time_ms DESC LIMIT 25`
    ).all().catch(() => emptyRows),
    env.DB.prepare(
      `SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN severity='rojo' THEN 1 ELSE 0 END), 0) AS critical,
        COALESCE(SUM(CASE WHEN category IN ('aid_point','water_point','shelter','medical_need') THEN 1 ELSE 0 END), 0) AS resources,
        COALESCE(SUM(CASE WHEN category='trapped_people' THEN 1 ELSE 0 END), 0) AS trapped
       FROM map_reports WHERE status='approved'`
    ).first().catch(() => ({ total: 0, critical: 0, resources: 0, trapped: 0 })),
    env.DB.prepare(`SELECT severity, COUNT(*) AS n FROM map_reports WHERE status='approved' GROUP BY severity`).all().catch(() => emptyRows),
    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM checkins GROUP BY status`).all().catch(() => emptyRows),
    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM sos_alerts GROUP BY status`).all().catch(() => emptyRows),
    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM resources GROUP BY status`).all().catch(() => emptyRows),
    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM shelter_status WHERE moderation='approved' GROUP BY status`).all().catch(() => emptyRows),
    env.DB.prepare(`SELECT commodity, SUM(qty) AS total, COUNT(DISTINCT center_id) AS centers FROM acopio_inventory GROUP BY commodity`).all().catch(() => emptyRows),
    env.DB.prepare(`SELECT status, priority, COUNT(*) AS n FROM acopio_needs GROUP BY status, priority`).all().catch(() => emptyRows),
    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM acopio_shipments GROUP BY status`).all().catch(() => emptyRows),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM acopio_custody`).first().catch(() => ({ n: 0 })),
    env.DB.prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN condition IN ('quarantine','damaged') THEN 1 ELSE 0 END), 0) AS quarantine,
        COALESCE(SUM(CASE WHEN qty > 0 AND expiration_ms IS NOT NULL AND expiration_ms < ? THEN 1 ELSE 0 END), 0) AS expired,
        COALESCE(SUM(CASE WHEN qty > 0 AND expiration_ms IS NOT NULL AND expiration_ms >= ? AND expiration_ms <= ? THEN 1 ELSE 0 END), 0) AS within30,
        COUNT(*) AS total_lots
       FROM acopio_inventory_lots`
    ).bind(now, now, now + 30 * DAY_MS).first().catch(() => ({ quarantine: 0, expired: 0, within30: 0, total_lots: 0 })),
    env.DB.prepare(
      `SELECT severity, verification, COUNT(*) AS n
       FROM sat_damage GROUP BY severity, verification`
    ).all().catch(() => emptyRows),
    env.DB.prepare(`SELECT source, last_ok_ms, last_error FROM ingest_log ORDER BY source`).all().catch(() => emptyRows),
  ]);

  const events = rows(latestEvents);
  const latest = events[0] ?? null;
  const threat = scoreThreat(events as any[], now);
  const event24h = events.filter((e) => Number(e.time_ms ?? 0) >= now - DAY_MS);
  const maxMag24h = event24h.reduce((m, e) => Math.max(m, Number(e.mag ?? 0)), 0);

  const checkinRows = rows(checkins);
  const sosRows = rows(sos);
  const resourceRows = rows(resources);
  const shelterRows = rows(shelters);
  const needRows = rows(needs);
  const shipRows = rows(ships);
  const social = adapterStatus(env as unknown as Record<string, unknown>);
  const gated = [
    { key: 'damage_ai', configured: Boolean((env as any).AI) },
    { key: 'openfema', configured: true },
  ];

  const openNeeds = needRows.filter((r) => r.status === 'open').reduce((a, r) => a + Number(r.n ?? 0), 0);
  const criticalNeeds = needRows.filter((r) => r.status === 'open' && Number(r.priority) === 1).reduce((a, r) => a + Number(r.n ?? 0), 0);
  const inTransit = shipRows.filter((r) => ['despachado', 'en_transito'].includes(r.status)).reduce((a, r) => a + Number(r.n ?? 0), 0);
  const delivered = shipRows.filter((r) => ['entregado', 'confirmado'].includes(r.status)).reduce((a, r) => a + Number(r.n ?? 0), 0);
  const unresolvedSos = sum(sosRows, (x) => ['active', 'acknowledged'].includes(x.status));
  const fullShelters = sum(shelterRows, (x) => x.status === 'lleno');
  const closedShelters = sum(shelterRows, (x) => x.status === 'cerrado');
  const report = reportStats as any;
  const satRows = rows(satDamage);
  const satSevere = sum(satRows, (x) => ['grave', 'severo'].includes(x.severity));
  const satUnverified = sum(satRows, (x) => x.verification === 'unverified');
  const satVerified = sum(satRows, (x) => x.verification === 'verified');
  const expiryRow = expiry as any;
  const lotsAtRisk = Number(expiryRow.expired ?? 0) + Number(expiryRow.within30 ?? 0) + Number(expiryRow.quarantine ?? 0);

  const readiness = pickReadiness([
    maxMag24h >= 6 || threat.label === 'Alerta Roja'
      ? level('emergency', [`Sismo máximo 24h M${maxMag24h.toFixed(1)}.`])
      : maxMag24h >= 4.5
        ? level('elevated', [`Actividad sísmica reciente M${maxMag24h.toFixed(1)}.`])
        : level('normal', ['Actividad sísmica dentro de vigilancia.']),
    unresolvedSos > 0
      ? level(unresolvedSos >= 10 ? 'emergency' : 'elevated', [`${unresolvedSos} SOS sin resolver.`])
      : level('normal', ['Sin SOS activos agregados.']),
    criticalNeeds > 0 || lotsAtRisk > 0
      ? level(criticalNeeds >= 5 ? 'emergency' : 'elevated', [`${criticalNeeds} necesidades críticas y ${lotsAtRisk} lotes en riesgo.`])
      : level('normal', ['Logística sin brecha crítica agregada.']),
    Number(report.critical ?? 0) > 0 || Number(report.trapped ?? 0) > 0
      ? level(Number(report.trapped ?? 0) > 0 ? 'emergency' : 'elevated', [`${report.critical ?? 0} reportes rojos; ${report.trapped ?? 0} con personas atrapadas.`])
      : level('normal', ['Sin reportes críticos aprobados.']),
    satSevere > 0
      ? level(satSevere >= 5 ? 'emergency' : 'elevated', [`${satSevere} evaluaciones satelitales graves/severas; ${satUnverified} sin verificar.`])
      : level('normal', ['Sin daño satelital grave agregado.']),
    fullShelters + closedShelters > 0
      ? level('watch', [`${fullShelters} refugios llenos y ${closedShelters} cerrados.`])
      : level('normal', ['Refugios sin estrés agregado.']),
  ]);

  const payload: any = {
    generated_ms: now,
    product: 'SISMO911 Common Operating Picture',
    scope: 'public_non_pii',
    readiness: {
      status: readiness.label,
      reasons: readiness.reasons,
      threat,
      priorities: [
        unresolvedSos > 0 ? 'Resolver SOS activos y confirmados.' : null,
        Number(report.trapped ?? 0) > 0 ? 'Priorizar rescate urbano en reportes con atrapados.' : null,
        criticalNeeds > 0 ? 'Cubrir necesidades logísticas prioridad 1.' : null,
        lotsAtRisk > 0 ? 'Revisar lotes vencidos/cuarentena antes de despacho.' : null,
        satSevere > 0 ? 'Verificar evaluaciones satelitales graves/severas.' : null,
        maxMag24h >= 4 ? 'Mantener monitoreo geosísmico y comunicaciones públicas.' : null,
      ].filter(Boolean),
    },
    geoseismic: {
      latest,
      last24h: event24h.length,
      maxMag24h,
      recent: events.length,
    },
    humanitarian: {
      checkins: { total: sum(checkinRows), safe: sum(checkinRows, (x) => x.status === 'safe'), need_help: sum(checkinRows, (x) => x.status === 'need_help') },
      sos: { by: sosRows, unresolved: unresolvedSos },
      resources: { by: resourceRows, low: sum(resourceRows, (x) => x.status === 'low'), depleted: sum(resourceRows, (x) => x.status === 'depleted'), total: sum(resourceRows) },
    },
    logistics: {
      commodities: rows(inv),
      needs: { by: needRows, open: openNeeds, critical: criticalNeeds },
      shipments: { by: shipRows, in_transit: inTransit, delivered, total: shipRows.reduce((a, r) => a + Number(r.n ?? 0), 0) },
      custody_events: Number((custody as any)?.n ?? 0),
      lots: { quarantine: Number(expiryRow.quarantine ?? 0), expired: Number(expiryRow.expired ?? 0), within30: Number(expiryRow.within30 ?? 0), at_risk: lotsAtRisk, total: Number(expiryRow.total_lots ?? 0) },
    },
    damage: {
      reports: { total: Number(report.total ?? 0), critical: Number(report.critical ?? 0), resources: Number(report.resources ?? 0), trapped: Number(report.trapped ?? 0), by_severity: rows(reportSeverity) },
      satellite: {
        by: satRows,
        total: sum(satRows),
        severe: satSevere,
        verified: satVerified,
        unverified: satUnverified,
      },
    },
    shelters: {
      by: shelterRows,
      active: sum(shelterRows, (x) => x.status === 'activo'),
      full: fullShelters,
      closed: closedShelters,
      total: sum(shelterRows),
    },
    feeds: {
      ingest: rows(ingest),
      social_configured: social.filter((s) => s.configured).length,
      social_live: social.filter((s) => s.configured).length,
      gated_configured: gated.filter((g) => g.configured).length,
    },
  };
  payload.esf = buildEsfStatus(payload);
  return payload;
}

function fmt(n: unknown) {
  return Number(n ?? 0).toLocaleString('es-VE');
}

const xesc = (v: unknown) => String(v ?? '').replace(/[<>&'"]/g, (ch) => ({
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  "'": '&apos;',
  '"': '&quot;',
}[ch]!));

function capSeverity(status: string) {
  if (status === 'emergency') return 'Extreme';
  if (status === 'elevated') return 'Severe';
  if (status === 'watch') return 'Moderate';
  return 'Minor';
}

function capUrgency(status: string) {
  return status === 'emergency' || status === 'elevated' ? 'Immediate' : 'Expected';
}

function timelineSeverity(kind: string, value: unknown) {
  const v = String(value ?? '').toLowerCase();
  if (kind === 'quake') return Number(value ?? 0) >= 6 ? 'emergency' : Number(value ?? 0) >= 4.5 ? 'elevated' : 'watch';
  if (['rojo', 'grave', 'severo'].includes(v)) return 'emergency';
  if (['naranja', 'moderado'].includes(v)) return 'elevated';
  if (['amarillo', 'leve', 'open', 'active', 'need_help', 'lleno', 'en_transito'].includes(v)) return 'watch';
  return 'normal';
}

export async function buildOperationalTimeline(env: Env, limit = 40, now = Date.now()) {
  const [
    events,
    reports,
    sat,
    needs,
    shipments,
    shelters,
    sos,
    checkins,
  ] = await Promise.all([
    env.DB.prepare(`SELECT id, mag, place, place_es, time_ms FROM events ORDER BY time_ms DESC LIMIT 12`).all().catch(() => emptyRows),
    env.DB.prepare(
      `SELECT category, severity, estado, municipio, created_ms
       FROM map_reports WHERE status='approved' ORDER BY created_ms DESC LIMIT 12`
    ).all().catch(() => emptyRows),
    env.DB.prepare(`SELECT severity, verification, created_ms FROM sat_damage ORDER BY created_ms DESC LIMIT 12`).all().catch(() => emptyRows),
    env.DB.prepare(`SELECT priority, status, updated_ms FROM acopio_needs WHERE status='open' ORDER BY updated_ms DESC LIMIT 12`).all().catch(() => emptyRows),
    env.DB.prepare(`SELECT status, updated_ms FROM acopio_shipments ORDER BY updated_ms DESC LIMIT 12`).all().catch(() => emptyRows),
    env.DB.prepare(`SELECT status, updated_ms FROM shelter_status WHERE moderation='approved' ORDER BY updated_ms DESC LIMIT 12`).all().catch(() => emptyRows),
    env.DB.prepare(
      `SELECT status, COUNT(*) AS n, MAX(COALESCE(updated_ms, created_ms)) AS updated_ms
       FROM sos_alerts WHERE COALESCE(status, 'active') != 'resolved' GROUP BY status`
    ).all().catch(() => emptyRows),
    env.DB.prepare(`SELECT status, COUNT(*) AS n, MAX(created_ms) AS updated_ms FROM checkins GROUP BY status`).all().catch(() => emptyRows),
  ]);

  const items: any[] = [];
  const push = (ts: unknown, domain: string, kind: string, severity: string, title: string, summary: string, metrics: Record<string, unknown> = {}) => {
    const time_ms = Number(ts ?? 0);
    if (!Number.isFinite(time_ms) || time_ms <= 0) return;
    items.push({ time_ms, domain, kind, severity, title, summary, metrics });
  };

  for (const row of rows(events)) {
    push(row.time_ms, 'geoseismic', 'quake', timelineSeverity('quake', row.mag), `Sismo M${Number(row.mag ?? 0).toFixed(1)}`, str(row.place_es ?? row.place, 160) ?? 'Evento sísmico', { magnitude: Number(row.mag ?? 0) });
  }
  for (const row of rows(reports)) {
    const loc = [str(row.municipio, 80), str(row.estado, 80)].filter(Boolean).join(', ');
    push(row.created_ms, 'damage', 'public_report', timelineSeverity('report', row.severity), 'Reporte ciudadano aprobado', `${str(row.category, 60) ?? 'reporte'}${loc ? ` · ${loc}` : ''}`, { severity: row.severity ?? null });
  }
  for (const row of rows(sat)) {
    push(row.created_ms, 'assessment', 'satellite_damage', timelineSeverity('satellite', row.severity), 'Evaluación satelital IA', `${str(row.severity, 30) ?? 'indeterminado'} · ${str(row.verification, 30) ?? 'unverified'}`, { verification: row.verification ?? null });
  }
  for (const row of rows(needs)) {
    push(row.updated_ms, 'logistics', 'need', Number(row.priority) === 1 ? 'elevated' : 'watch', 'Necesidad logística abierta', `Prioridad ${Number(row.priority ?? 2)} · ${str(row.status, 30) ?? 'open'}`, { priority: Number(row.priority ?? 2) });
  }
  for (const row of rows(shipments)) {
    push(row.updated_ms, 'logistics', 'shipment', timelineSeverity('shipment', row.status), 'Movimiento logístico actualizado', str(row.status, 40) ?? 'actualizado', {});
  }
  for (const row of rows(shelters)) {
    push(row.updated_ms, 'shelter', 'shelter_status', timelineSeverity('shelter', row.status), 'Estado de refugio publicado', str(row.status, 40) ?? 'actualizado', {});
  }
  for (const row of rows(sos)) {
    push(row.updated_ms, 'humanitarian', 'sos_aggregate', timelineSeverity('sos', row.status), 'SOS agregados activos', `${fmt(row.n)} señales · ${str(row.status, 40) ?? 'active'}`, { count: Number(row.n ?? 0) });
  }
  for (const row of rows(checkins)) {
    push(row.updated_ms, 'humanitarian', 'checkin_aggregate', timelineSeverity('checkin', row.status), 'Check-ins agregados', `${fmt(row.n)} registros · ${str(row.status, 40) ?? 'unknown'}`, { count: Number(row.n ?? 0) });
  }

  const capped = items
    .sort((a, b) => b.time_ms - a.time_ms)
    .slice(0, Math.min(100, Math.max(1, limit)));
  return {
    generated_ms: now,
    scope: 'public_non_pii',
    privacy: 'aggregate_and_public_operational_events_no_pii',
    count: capped.length,
    items: capped,
  };
}

export function buildCapAlertXml(s: any) {
  const generated = new Date(Number(s.generated_ms ?? Date.now())).toISOString();
  const status = String(s.readiness?.status ?? 'normal');
  const latest = s.geoseismic?.latest;
  const maxMag = Number(s.geoseismic?.maxMag24h ?? 0).toFixed(1);
  const priorities = (s.readiness?.priorities ?? s.readiness?.reasons ?? []).slice(0, 5);
  const esf = (s.esf?.functions ?? []).slice(0, 8);
  const headline = `SISMO911 ${status.toUpperCase()} - Venezuela Earthquake Response`;
  const description = [
    `Public non-PII common operating picture generated ${generated}.`,
    `Max magnitude 24h: M ${maxMag}.`,
    `SOS unresolved: ${fmt(s.humanitarian?.sos?.unresolved)}.`,
    `Critical reports: ${fmt(s.damage?.reports?.critical)}; trapped-person reports: ${fmt(s.damage?.reports?.trapped)}.`,
    `Critical logistics needs: ${fmt(s.logistics?.needs?.critical)}; lot risk: ${fmt(s.logistics?.lots?.at_risk)}.`,
  ].join(' ');
  const instruction = priorities.length ? priorities.join(' ') : 'Continue monitoring official emergency channels and SISMO911 public updates.';

  return `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>sismo911-${Number(s.generated_ms ?? Date.now())}</identifier>
  <sender>alerts@sismo911.com</sender>
  <sent>${xesc(generated)}</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <source>SISMO911 Common Operating Picture</source>
  <note>Public non-PII operational alert; verify life-safety actions with official emergency authorities.</note>
  <info>
    <language>es-VE</language>
    <category>Geo</category>
    <category>Rescue</category>
    <category>Safety</category>
    <event>Venezuela Earthquake Response / SISMO911</event>
    <responseType>Monitor</responseType>
    <responseType>Prepare</responseType>
    <urgency>${capUrgency(status)}</urgency>
    <severity>${capSeverity(status)}</severity>
    <certainty>Observed</certainty>
    <eventCode><valueName>SISMO911_READINESS</valueName><value>${xesc(status)}</value></eventCode>
    <effective>${xesc(generated)}</effective>
    <expires>${xesc(new Date(Number(s.generated_ms ?? Date.now()) + 30 * 60_000).toISOString())}</expires>
    <senderName>SISMO911</senderName>
    <headline>${xesc(headline)}</headline>
    <description>${xesc(description)}</description>
    <instruction>${xesc(instruction)}</instruction>
    <web>https://sismo911.com/dashboard</web>
    <parameter><valueName>scope</valueName><value>public_non_pii</value></parameter>
    <parameter><valueName>latest_event</valueName><value>${xesc(latest?.place_es ?? latest?.place ?? 'N/A')}</value></parameter>
    <parameter><valueName>max_magnitude_24h</valueName><value>${xesc(maxMag)}</value></parameter>
${esf.map((fn: any) => `    <parameter><valueName>${xesc(fn.code)}</valueName><value>${xesc(`${fn.status}:${fn.score}`)}</value></parameter>`).join('\n')}
    <area>
      <areaDesc>Venezuela</areaDesc>
      <geocode><valueName>ISO3166-1</valueName><value>VE</value></geocode>
    </area>
  </info>
</alert>
`;
}

export function buildIcs209Text(s: any) {
  const generated = new Date(Number(s.generated_ms ?? Date.now())).toISOString();
  const priorities = (s.readiness?.priorities ?? s.readiness?.reasons ?? []).slice(0, 6);
  return [
    'SISMO911 ICS-209-LITE INCIDENT STATUS SUMMARY',
    'PUBLIC NON-PII / OPERATIONAL DRAFT',
    '',
    `1. INCIDENT: Venezuela Earthquake Response / SISMO911`,
    `2. GENERATED: ${generated}`,
    `3. READINESS: ${String(s.readiness?.status ?? 'normal').toUpperCase()}`,
    `4. THREAT: ${s.readiness?.threat?.label ?? 'Vigilancia'} - ${s.readiness?.threat?.reason ?? 'Sin razon registrada.'}`,
    '',
    '5. GEOSISMIC SUMMARY',
    `   Latest event: ${s.geoseismic?.latest?.place_es ?? s.geoseismic?.latest?.place ?? 'N/A'}`,
    `   Max magnitude 24h: M ${Number(s.geoseismic?.maxMag24h ?? 0).toFixed(1)}`,
    `   Events 24h/recent window: ${fmt(s.geoseismic?.last24h)} / ${fmt(s.geoseismic?.recent)}`,
    '',
    '6. LIFE SAFETY / HUMANITARIAN',
    `   SOS unresolved: ${fmt(s.humanitarian?.sos?.unresolved)}`,
    `   Check-ins safe / need help: ${fmt(s.humanitarian?.checkins?.safe)} / ${fmt(s.humanitarian?.checkins?.need_help)}`,
    `   Public resources low/depleted: ${fmt((s.humanitarian?.resources?.low ?? 0) + (s.humanitarian?.resources?.depleted ?? 0))}`,
    '',
    '7. DAMAGE AND ASSESSMENT',
    `   Approved critical reports: ${fmt(s.damage?.reports?.critical)}`,
    `   Trapped-person reports: ${fmt(s.damage?.reports?.trapped)}`,
    `   Satellite severe/unverified: ${fmt(s.damage?.satellite?.severe)} / ${fmt(s.damage?.satellite?.unverified)}`,
    '',
    '8. LOGISTICS / ESF-7',
    `   Open needs / critical needs: ${fmt(s.logistics?.needs?.open)} / ${fmt(s.logistics?.needs?.critical)}`,
    `   Shipments in transit / delivered: ${fmt(s.logistics?.shipments?.in_transit)} / ${fmt(s.logistics?.shipments?.delivered)}`,
    `   Lot risk count: ${fmt(s.logistics?.lots?.at_risk)}`,
    `   Custody events: ${fmt(s.logistics?.custody_events)}`,
    '',
    '9. SHELTERS',
    `   Active / full / closed: ${fmt(s.shelters?.active)} / ${fmt(s.shelters?.full)} / ${fmt(s.shelters?.closed)}`,
    '',
    '10. MISSION PRIORITIES',
    ...(priorities.length ? priorities.map((p: string, i: number) => `   ${i + 1}. ${p}`) : ['   1. Continue monitoring and public information operations.']),
    '',
    '11. ESF MISSION STATUS',
    ...((s.esf?.functions ?? []).slice(0, 8).map((x: any) => `   ${x.code} ${x.title}: ${String(x.status).toUpperCase()} (score ${fmt(x.score)})`)),
    '',
    '12. DATA STATUS',
    `   Ingest sources: ${fmt(s.feeds?.ingest?.length)}`,
    `   Social live/configured: ${fmt(s.feeds?.social_live)} / ${fmt(s.feeds?.social_configured)}`,
    `   Gated configured: ${fmt(s.feeds?.gated_configured)}`,
    '',
    '13. LIMITATIONS',
    '   This is a public non-PII operational summary generated from SISMO911 datasets.',
    '   Satellite/AI/PyTorch assessments remain unverified until operator review.',
    '   Verify life-safety actions with official emergency authorities.',
    '',
  ].join('\n');
}

// GET /api/sitrep — public, non-PII common operating picture.
// This is a FEMA/NIMS-style aggregate for dashboards, partners and responders:
// geoseismic posture, humanitarian load, ESF-7 logistics, public damage reports,
// shelters, and feed readiness in one D1-backed response.
sitrep.get('/', async (c) => {
  const payload = await buildSitrep(c.env);
  return c.json(payload, 200, { 'Cache-Control': 'public, max-age=30' });
});

// GET /api/sitrep/esf — public FEMA-style ESF mission matrix derived from the
// same aggregate, non-PII common operating picture as /api/sitrep.
sitrep.get('/esf', async (c) => {
  const payload = await buildSitrep(c.env);
  return c.json(payload.esf, 200, { 'Cache-Control': 'public, max-age=30' });
});

// GET /api/sitrep/cap — CAP 1.2-shaped XML alert for downstream public alerting
// systems. This is derived from aggregate sitrep fields only and contains no
// incident-level PII or coordinates.
sitrep.get('/cap', async (c) => {
  const payload = await buildSitrep(c.env);
  return c.body(buildCapAlertXml(payload), 200, {
    'Cache-Control': 'public, max-age=30',
    'Content-Type': 'application/cap+xml; charset=utf-8',
    'Content-Disposition': 'inline; filename="sismo911-cap.xml"',
  });
});

// GET /api/sitrep/timeline — public non-PII operational timeline across
// geoseismic, logistics, humanitarian, shelter and assessment signals.
sitrep.get('/timeline', async (c) => {
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 40)));
  const payload = await buildOperationalTimeline(c.env, limit);
  return c.json(payload, 200, { 'Cache-Control': 'public, max-age=30' });
});

// GET /api/sitrep/ics-209 — plain-text public incident status summary.
sitrep.get('/ics-209', async (c) => {
  const payload = await buildSitrep(c.env);
  return c.text(buildIcs209Text(payload), 200, {
    'Cache-Control': 'public, max-age=30',
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': 'inline; filename="sismo911-ics-209.txt"',
  });
});
