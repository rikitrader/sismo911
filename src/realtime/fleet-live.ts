// FleetLive — the live-GPS hub Durable Object. Holds two kinds of WebSocket
// connections (tagged via the Hibernation API):
//   - 'unit'  : a field phone streaming GPS (token already verified by the Worker
//               before the upgrade; unit_id/token_id arrive as headers)
//   - 'admin' : an operator console subscribing to live unit movement
// Each unit 'gps' message is rate-limited, validated + stored via ingestGps(),
// then broadcast to all admin subscribers. Admins are read-only.
//
// Plain-class DO (no `cloudflare:workers` import) so it loads under vitest, same
// as FlotaTracking.

import type { Env } from '../types';
import { ingestGps, withinRate } from '../lib/flota-ingest';

interface Attach { role: 'unit' | 'admin'; unitId?: string; tokenId?: string }

const RATE_LIMIT = 60;         // max GPS fixes
const RATE_WINDOW_MS = 60_000; // per 60s, per unit

export class FleetLive {
  private rates = new Map<string, number[]>();
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const role = (request.headers.get('x-flota-role') as 'unit' | 'admin') || 'admin';
    const unitId = request.headers.get('x-flota-unit-id') || undefined;
    const tokenId = request.headers.get('x-flota-token-id') || undefined;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, unitId, tokenId } satisfies Attach);

    if (role === 'unit' && unitId) {
      const unit = await this.env.DB.prepare(`SELECT name, status FROM flota_units WHERE id = ?`).bind(unitId)
        .first() as { name: string; status: string } | null;
      try {
        server.send(JSON.stringify({ type: 'hello', unitId, unitName: unit?.name ?? null, status: unit?.status ?? null }));
      } catch { /* race */ }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = (ws.deserializeAttachment() ?? { role: 'admin' }) as Attach;
    if (typeof message !== 'string') return;

    if (att.role !== 'unit' || !att.unitId) {
      if (message === 'ping') { try { ws.send('{"type":"pong"}'); } catch { /* gone */ } }
      return;
    }

    let msg: any;
    try { msg = JSON.parse(message); } catch { try { ws.send('{"type":"error","error":"malformed_payload"}'); } catch {} return; }
    if (msg === 'ping' || msg?.type === 'ping') { try { ws.send('{"type":"pong"}'); } catch {} return; }
    if (msg?.type !== 'gps') return;

    const now = Date.now();
    const recent = this.rates.get(att.unitId) ?? [];
    const rl = withinRate(recent, now, RATE_LIMIT, RATE_WINDOW_MS);
    this.rates.set(att.unitId, rl.kept);
    if (!rl.allowed) { try { ws.send('{"type":"rate_limited"}'); } catch {} return; }

    const res = await ingestGps(this.env, { unitId: att.unitId, tokenId: att.tokenId }, msg, now);
    if (!res.ok) {
      try { ws.send(JSON.stringify({ type: 'error', error: res.error })); } catch { /* gone */ }
      return;
    }
    try { ws.send(JSON.stringify({ type: 'ack', at: res.location.received_at })); } catch { /* gone */ }
    this.broadcastAdmins({ type: 'unit_location', ...res.location });
  }

  webSocketClose(ws: WebSocket) { try { ws.close(); } catch { /* already closed */ } }
  webSocketError(ws: WebSocket) { try { ws.close(); } catch { /* already closed */ } }

  private broadcastAdmins(obj: unknown) {
    const data = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets('admin')) {
      try { ws.send(data); } catch { /* drop dead socket */ }
    }
  }
}
