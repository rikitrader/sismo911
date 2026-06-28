// FlotaTracking — a Durable Object holding the live WebSocket subscribers that
// watch unit movement on the command map. Field units POST positions to
// /api/flota/rastreo/posicion (REST); that handler also publishes the fix here,
// and this DO fans it out to every connected operator console in real time.
//
// Uses the WebSocket Hibernation API (state.acceptWebSocket / getWebSockets) so
// idle connections cost nothing — SQLite-backed DO, free-tier compatible.
//
// This is the one piece that genuinely cannot live on a stateless Worker, which
// is why Fleetbase's always-on socket server maps to a Durable Object here.

import type { Env } from '../types';

export class FlotaTracking {
  constructor(private state: DurableObjectState, _env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Server-side publish from the REST ingest handler.
    if (request.method === 'POST' && url.pathname.endsWith('/publish')) {
      const data = await request.text();
      this.broadcast(data);
      return new Response('ok');
    }

    // Client (operator console) WebSocket subscription.
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('expected websocket', { status: 426 });
  }

  // Subscribers are read-only; we still answer a ping to keep proxies happy.
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message === 'string' && message === 'ping') {
      try { ws.send('pong'); } catch { /* gone */ }
    }
  }

  webSocketClose(ws: WebSocket) {
    try { ws.close(); } catch { /* already closed */ }
  }

  webSocketError(ws: WebSocket) {
    try { ws.close(); } catch { /* already closed */ }
  }

  private broadcast(data: string) {
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(data); } catch { /* drop dead sockets silently */ }
    }
  }
}
