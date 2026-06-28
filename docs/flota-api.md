# FLOTA API — Fleet Operations & Dispatch

The **FLOTA** module is SISMO911's internal fleet-operations console: response units
(vehicles), responder personnel, fleets (groupings), mission dispatch with a lifecycle
state machine, live GPS tracking, and a command dashboard. Every endpoint is mounted
under the `/api/flota` prefix.

All routes live in `src/routes/flota-*.ts`; the per-unit GPS token helpers live in
`src/lib/flota-token.ts`; the central auth gate lives in `src/index.ts`.

---

## Authentication & gating

The whole `/api/flota` surface is an **internal dispatch console**. The central gate in
`src/index.ts` sets:

```js
const isFlotaApi = path.startsWith('/api/flota'); // operator/admin only for ALL methods
```

This means **every method on every `/api/flota` path — including `GET` reads — requires an
authenticated operator or admin session.** Reads are not public: they expose responder GPS
positions and PII. (Some route-file header comments still say "GET reads are public"; the
`isFlotaApi` gate in `index.ts` is authoritative and overrides them — the entire module is
operator/admin-gated.)

| Caller | Mechanism | What it can reach |
|--------|-----------|-------------------|
| **Operator / Admin** | Logged-in session cookie, `role` ∈ {`operator`, `admin`} | Every `/api/flota/...` endpoint, all methods |
| **Field unit (GPS device)** | Scoped per-unit bearer token (`fbu_...`) | **Only** `POST /api/flota/rastreo/posicion` |

### Operator/admin session

Resolved via `getUserFromRequest`. Unsafe (write) methods additionally enforce a same-site
origin check:

| Condition | Response |
|-----------|----------|
| No/expired session, or role not operator/admin | `401 { "error": "unauthorized", "hint": "Inicia sesión como operador o admin" }` |
| Authorized but cross-site unsafe method | `403 { "error": "bad_origin" }` |
| Authorized | request proceeds; `X-User-Role` header set on the response |

### Field-unit token carve-out

The **only** unauthenticated-session path through the gate is the GPS ingest endpoint. In
`src/index.ts`:

```js
if (method === 'POST' && path === '/api/flota/rastreo/posicion') {
  const unidad = await verifyUnitToken(c.env, unitTokenFromRequest(c.req.raw)).catch(() => null);
  if (unidad) return next(); // valid unit token → allowed, bypasses the same-site check
}
```

A valid per-unit token authorizes **only** `POST /api/flota/rastreo/posicion` and bypasses
the browser same-site check (field devices aren't browsers). Any other `/api/flota` path
still requires an operator/admin session. See [Field-unit token flow](#field-unit-token-flow).

---

## Resource index

| Resource | Mount | File |
|----------|-------|------|
| [Unidades (units)](#unidades-units) | `/api/flota/unidades` | `flota-unidades.ts` |
| [Personal (crew)](#personal-crew) | `/api/flota/personal` | `flota-personal.ts` |
| [Flotas (fleets)](#flotas-fleets) | `/api/flota/flotas` | `flota-flotas.ts` |
| [Misiones (missions)](#misiones-missions) | `/api/flota/misiones` | `flota-misiones.ts` |
| [Rastreo (tracking)](#rastreo-tracking) | `/api/flota/rastreo` | `flota-rastreo.ts` |
| [Tablero (dashboard)](#tablero-dashboard) | `/api/flota/tablero` | `flota-tablero.ts` |

Common conventions:
- IDs are prefixed (`uni_`, `per_`, `flt_`, `mis_`, `wpt_`, `act_`, `pos_`, `tok_`).
- String fields are trimmed and length-capped; over-long strings are silently truncated.
- Timestamps are epoch milliseconds (`created_ms`, `updated_ms`, `ult_pos_ms`, `ts_ms`, ...).
- A malformed/empty JSON body yields the field-validation `400` (e.g. `nombre requerido`).

---

## Unidades (units)

Response vehicles. Table `flota_unidades`. Mounted at `/api/flota/unidades`.

- **`tipo`** ∈ `ambulancia`, `rescate`, `bomberos`, `carga`, `moto`, `dron`, `otro` (default `rescate`)
- **`estado_op`** ∈ `disponible`, `en_mision`, `fuera_servicio`, `mantenimiento` (default `disponible`)

### `GET /api/flota/unidades`
List units. Query params: `estado_op` (filter, must be a valid op-state), `tipo` (filter,
must be a valid type), `limit` (default `200`, max `1000`). Invalid filter values are ignored.

Response: `200 { "results": [ <unidad row>, ... ] }` ordered by `created_ms DESC`.

### `POST /api/flota/unidades`
Create a unit.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `nombre` | string | **yes** | ≤160 chars |
| `tipo` | string | no | one of TIPOS; default `rescate` |
| `estado_op` | string | no | one of ESTADOS_OP; default `disponible` |
| `placa` | string | no | ≤40 |
| `capacidad` | number | no | |
| `organizacion` | string | no | ≤160 |
| `estado_region` | string | no | ≤80 |
| `lat` / `lon` | number | no | |
| `rumbo` | number | no | heading |
| `ult_pos_ms` | number | no | |
| `notas` | string | no | ≤1000 |

| Status | Body |
|--------|------|
| `201` | the full created unit row |
| `400` | `{ "error": "nombre requerido" }` |
| `400` | `{ "error": "tipo inválido" }` |
| `400` | `{ "error": "estado_op inválido" }` |

### `GET /api/flota/unidades/:id`
One unit. `200` row, or `404 { "error": "no encontrado" }`.

### `PATCH /api/flota/unidades/:id`
Update mutable fields: `nombre`, `tipo`, `estado_op`, `placa`, `capacidad`, `organizacion`,
`estado_region`, `notas` (`updated_ms` is auto-bumped).

| Status | Body |
|--------|------|
| `200` | the updated unit row |
| `400` | `{ "error": "nombre inválido" }` / `tipo inválido` / `estado_op inválido` |
| `400` | `{ "error": "nada que actualizar" }` (no recognized fields) |
| `404` | `{ "error": "no encontrado" }` |

### `DELETE /api/flota/unidades/:id`
Delete a unit. Refuses if the unit is on a still-active mission. On success it also cleans up
fleet memberships, nulls personnel `unidad_id`, and deletes its GPS tokens.

| Status | Body |
|--------|------|
| `200` | `{ "ok": true, "id": "<id>" }` |
| `404` | `{ "error": "no encontrado" }` |
| `409` | `{ "error": "unidad_en_mision_activa" }` (assigned to a non-terminal mission) |

### `POST /api/flota/unidades/:id/token`
Issue a scoped GPS token for the unit. **The plaintext token is returned ONCE** — store it.

Body: `{ "label": "<optional ≤120 chars>" }`.

| Status | Body |
|--------|------|
| `201` | `{ "ok": true, "id": "tok_...", "token": "fbu_<prefix>_<secret>", "prefix": "<8hex>", "aviso": "Guarde este token: no se mostrará de nuevo." }` |
| `404` | `{ "error": "no encontrado" }` (unit doesn't exist) |

### `GET /api/flota/unidades/:id/tokens`
List a unit's tokens (metadata only; the secret is never returned).

Response: `200 { "results": [ { id, token_prefix, label, created_ms, last_used_ms, revoked_ms }, ... ] }`.

### `DELETE /api/flota/unidades/:id/token/:tokenId`
Revoke a token (sets `revoked_ms`).

| Status | Body |
|--------|------|
| `200` | `{ "ok": true, "id": "<tokenId>", "revoked": true }` |
| `404` | `{ "error": "no encontrado" }` (already revoked or missing) |

---

## Personal (crew)

Responders. Table `flota_personal`. Mounted at `/api/flota/personal`. `skills` is stored as a
JSON string array and returned parsed.

- **`rol`** ∈ `paramedico`, `rescatista`, `conductor`, `coordinador`, `voluntario` (default `rescatista`)
- **`estado`** ∈ `activo`, `inactivo`, `en_mision` (default `activo`)

### `GET /api/flota/personal`
List crew. Query params: `rol`, `unidad_id`, `estado` (each an exact-match filter; invalid
enum values are ignored). Capped at 1000, ordered by `nombre`. Each row's `skills` is returned
as a parsed array.

Response: `200 { "results": [ { id, nombre, rol, telefono, email, unidad_id, estado, skills: [...], created_ms, updated_ms }, ... ] }`.

### `POST /api/flota/personal`
Create a responder.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `nombre` | string | **yes** | ≤160 |
| `rol` | string | no | one of ROLES; default `rescatista` |
| `estado` | string | no | one of ESTADOS; default `activo` |
| `telefono` | string | no | ≤40 |
| `email` | string | no | ≤160 |
| `unidad_id` | string | no | ≤120; assigned unit |
| `skills` | string[] \| comma-string | no | normalized to ≤40 items, ≤60 chars each |

| Status | Body |
|--------|------|
| `201` | `{ "ok": true, "id": "per_...", "nombre", "rol", "estado", "skills": [...] }` |
| `400` | `{ "error": "nombre requerido" }` / `rol inválido` / `estado inválido` |

### `GET /api/flota/personal/:id`
One responder (`skills` parsed). `200` row or `404 { "error": "no encontrado" }`.

### `PATCH /api/flota/personal/:id`
Update `nombre`, `rol`, `estado`, `telefono`, `email`, `unidad_id`, `skills`.

| Status | Body |
|--------|------|
| `200` | `{ "ok": true, "id": "<id>" }` |
| `400` | `{ "error": "nombre inválido" }` / `rol inválido` / `estado inválido` / `nada que actualizar` |
| `404` | `{ "error": "no encontrado" }` |

### `DELETE /api/flota/personal/:id`
Delete. `200 { "ok": true, "id": "<id>" }` or `404 { "error": "no encontrado" }`.

---

## Flotas (fleets)

Named groupings of units. Table `flota_flotas` + membership table `flota_flota_unidades`.
Mounted at `/api/flota/flotas`.

### `GET /api/flota/flotas`
List fleets with member counts.

Response: `200 { "results": [ { id, nombre, organizacion, estado_region, descripcion, created_ms, unidades_count }, ... ] }` (max 1000, newest first).

### `POST /api/flota/flotas`
Create a fleet.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `nombre` | string | **yes** | ≤160 |
| `organizacion` | string | no | ≤160 |
| `estado_region` | string | no | ≤120 |
| `descripcion` | string | no | ≤1000 |

| Status | Body |
|--------|------|
| `201` | `{ "ok": true, "id": "flt_...", "nombre" }` |
| `400` | `{ "error": "nombre requerido" }` |

### `GET /api/flota/flotas/:id`
Fleet detail + member units.

Response: `200 { id, nombre, organizacion, estado_region, descripcion, created_ms, unidades: [ { id, nombre, tipo, estado_op }, ... ] }`, or `404 { "error": "no encontrado" }`.

### `PATCH /api/flota/flotas/:id`
Update `nombre`, `organizacion`, `estado_region`, `descripcion`.

| Status | Body |
|--------|------|
| `200` | `{ "ok": true, "id": "<id>" }` |
| `400` | `{ "error": "nombre inválido" }` / `nada que actualizar` |
| `404` | `{ "error": "no encontrado" }` |

### `DELETE /api/flota/flotas/:id`
Delete the fleet and its membership rows.

| Status | Body |
|--------|------|
| `200` | `{ "ok": true, "id": "<id>" }` |
| `404` | `{ "error": "no encontrado" }` |

### `POST /api/flota/flotas/:id/unidades`
Add a unit to the fleet. Body: `{ "unidad_id": "<id>" }` (required, ≤120). Idempotent
(`INSERT OR IGNORE`).

| Status | Body |
|--------|------|
| `200` | `{ "ok": true, "flota_id": "<id>", "unidad_id": "<id>" }` |
| `400` | `{ "error": "unidad_id requerido" }` |
| `404` | `{ "error": "flota no encontrada" }` |
| `404` | `{ "error": "unidad no encontrada" }` |

### `DELETE /api/flota/flotas/:id/unidades/:unidadId`
Remove a unit from the fleet.

| Status | Body |
|--------|------|
| `200` | `{ "ok": true, "flota_id": "<id>", "unidad_id": "<id>" }` |
| `404` | `{ "error": "no encontrado" }` (not a member) |

---

## Misiones (missions)

Mission dispatch — the "order" in FleetOps. Tables `flota_misiones`,
`flota_mision_waypoints`, `flota_mision_actividad`; also updates `flota_unidades.estado_op`
when a unit is assigned/freed. Mounted at `/api/flota/misiones`.

- **`tipo`** ∈ `rescate`, `evacuacion`, `suministro`, `evaluacion`, `medico`, `traslado` (default `rescate`)
- **`estado`** ∈ `creada`, `despachada`, `en_ruta`, `en_sitio`, `completada`, `cancelada`
- **`prioridad`** integer 1–5 (default `3`)
- Coordinates use `validLatLon`; a present-but-out-of-range pair is rejected.

### Mission state machine

```
                         ┌──────────────────────────── cancelada
                         │      (from any non-terminal state)
                         │
  creada ──despachar──> despachada ──> en_ruta ──> en_sitio ──> completada
   (POST /:id/despachar)  └─────────── POST /:id/estado ──────────┘
```

Rules (`canTransition` in `flota-misiones.ts`):
- Linear order: `creada → despachada → en_ruta → en_sitio → completada`. Each step advances
  **exactly one** position.
- `despachada` is reachable **only** via `POST /:id/despachar` (which also requires a free unit).
  `POST /:id/estado` accepts only `en_ruta`, `en_sitio`, `completada`, `cancelada`.
- `cancelada` is reachable from **any non-terminal** state.
- **Terminal** states are `completada` and `cancelada`: no transition out of them is valid.
- An invalid jump (e.g. `creada → completada`, or any move out of a terminal state) →
  `409 { "error": "transicion_invalida" }`.
- Entering `completada` or `cancelada` frees the assigned unit back to `estado_op='disponible'`.

### `GET /api/flota/misiones`
List missions. Query params: `estado`, `tipo`, `evento_id`, `prioridad` (integer), `limit`
(default `100`, max `500`). Invalid enum/integer filters are ignored.

Response: `200 { "results": [ <mision row>, ... ] }` newest first.

### `POST /api/flota/misiones`
Create a mission (state starts at `creada`). **Rate limited** (60 req / 60 s); over the limit
returns the rate-limit response.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `tipo` | string | no | one of TIPOS; default `rescate` |
| `descripcion` | string | **yes** | ≤2000 |
| `prioridad` | int 1–5 | no | out-of-range coerced to `3` |
| `unidad_id` | string | no | ≤64 (pre-assignment; dispatch still required to mark `despachada`) |
| `personal_id` | string | no | ≤64 |
| `evento_id` | string | no | ≤64 (link to a seismic event) |
| `caso_ref` | string | no | ≤200 |
| `origen_lat` / `origen_lon` | number | no | validated as a pair |
| `origen_dir` | string | no | ≤400 |
| `destino_lat` / `destino_lon` | number | no | validated as a pair |
| `destino_dir` | string | no | ≤400 |
| `meta` | object | no | stored as JSON |
| `nota` | string | no | ≤400, seeds the first activity row |
| `actor` | string | no | ≤120 |
| `waypoints` | array | no | each `{ lat, lon, direccion }`; only lat+lon-complete entries kept, ≤50 |

A unique `codigo` (`MIS-XXXXXXXX`) is generated.

| Status | Body |
|--------|------|
| `201` | `{ "ok": true, "id": "mis_...", "codigo": "MIS-...", "estado": "creada" }` |
| `400` | `{ "error": "tipo inválido" }` |
| `400` | `{ "error": "descripcion requerida" }` |
| `400` | `{ "error": "bad_origen_lat_lon" }` |
| `400` | `{ "error": "bad_destino_lat_lon" }` |
| `429` | rate-limit response |

### `GET /api/flota/misiones/:id`
Mission detail with waypoints and activity log (`meta` parsed).

Response: `200 { "mision": { ...row, meta }, "waypoints": [...], "actividad": [...] }`, or
`404 { "error": "no encontrado" }`.

### `PATCH /api/flota/misiones/:id`
Update editable fields: `prioridad` (1–5), `tipo`, `descripcion`, `caso_ref`, `origen_lat`/
`origen_lon` (pair), `origen_dir`, `destino_lat`/`destino_lon` (pair), `destino_dir`, `meta`.
This does **not** change `estado` — use the dispatch/transition endpoints for that.

| Status | Body |
|--------|------|
| `200` | `{ "ok": true, "id": "<id>" }` |
| `400` | `{ "error": "prioridad inválida" }` / `tipo inválido` / `bad_origen_lat_lon` / `bad_destino_lat_lon` / `nada que actualizar` |
| `404` | `{ "error": "no encontrado" }` |

### `POST /api/flota/misiones/:id/despachar`
Dispatch: assign a unit, transition `creada → despachada`. Sets the unit to
`estado_op='en_mision'` and records `despachada_ms` + an activity row.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `unidad_id` | string | **yes** | ≤64; the unit to assign |
| `personal_id` | string | no | ≤64 |
| `nota` | string | no | ≤400 |
| `actor` | string | no | ≤120 |

| Status | Body |
|--------|------|
| `200` | `{ "ok": true, "id": "<id>", "estado": "despachada", "unidad_id", "personal_id" }` |
| `400` | `{ "error": "unidad_id requerido" }` |
| `404` | `{ "error": "no encontrado" }` (mission not found) |
| `404` | `{ "error": "unidad_no_encontrada" }` |
| `409` | `{ "error": "transicion_invalida" }` (mission not in `creada`) |
| `409` | `{ "error": "unidad_no_disponible", "estado_op": "<current>" }` (unit not `disponible`) |

### `POST /api/flota/misiones/:id/estado`
Advance the mission: `en_ruta`, `en_sitio`, `completada`, or `cancelada` (per the
[state machine](#mission-state-machine)). Records an activity row (with optional `lat`/`lon`);
`completada`/`cancelada` free the assigned unit.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `estado` | string | **yes** | one of `en_ruta`, `en_sitio`, `completada`, `cancelada` |
| `nota` | string | no | ≤400 |
| `lat` / `lon` | number | no | logged on the activity row |
| `actor` | string | no | ≤120 |

| Status | Body |
|--------|------|
| `200` | `{ "ok": true, "mision": { ...row, meta } }` |
| `400` | `{ "error": "estado inválido" }` |
| `404` | `{ "error": "no encontrado" }` |
| `409` | `{ "error": "transicion_invalida" }` (illegal transition per state machine) |

### `POST /api/flota/misiones/:id/waypoints`
Append a waypoint (auto-incremented `seq`, status `pendiente`). Body: `{ lat, lon, direccion? }`
(`lat`+`lon` required).

| Status | Body |
|--------|------|
| `201` | `{ "ok": true, "id": "wpt_...", "seq": <n> }` |
| `400` | `{ "error": "lat y lon requeridos" }` |
| `404` | `{ "error": "no encontrado" }` |

### `PATCH /api/flota/misiones/:id/waypoints/:wpId`
Update a waypoint's status. Body: `{ "estado": "pendiente" | "llegada" | "completado" }`.

| Status | Body |
|--------|------|
| `200` | `{ "ok": true, "id": "<wpId>", "estado": "<estado>" }` |
| `400` | `{ "error": "estado inválido" }` |
| `404` | `{ "error": "no encontrado" }` (waypoint not on that mission) |

### `DELETE /api/flota/misiones/:id`
Delete a mission, cascading its waypoints + activity. If it was still active, its unit is freed
to `disponible`.

| Status | Body |
|--------|------|
| `200` | `{ "ok": true, "id": "<id>" }` |
| `404` | `{ "error": "no encontrado" }` |

---

## Rastreo (tracking)

Live GPS: position ingest + map reads + real-time WebSocket. Append-only track in
`flota_posiciones`; each fix also denormalizes the latest position onto `flota_unidades`
(`lat`/`lon`/`rumbo`/`ult_pos_ms`). Mounted at `/api/flota/rastreo`.

> The whole module is operator/admin-only **except** `POST /api/flota/rastreo/posicion`,
> which also accepts a scoped per-unit token (see [Field-unit token flow](#field-unit-token-flow)).

### `POST /api/flota/rastreo/posicion`
Ingest one GPS fix. **Rate limited** (120 req / 60 s). Auth: operator/admin session **or** a
valid field-unit token. When a unit token is presented, the unit it authorizes
**authoritatively** identifies the posting unit (a unit can only report its own position),
overriding any `unidad_id` in the body. Operator sessions supply `unidad_id` in the body.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `unidad_id` | string | conditionally | ≤120; required for operator posts; **ignored** when a unit token is presented |
| `lat` / `lon` | number | **yes** | must pass `validLatLon` |
| `rumbo` | number | no | heading |
| `velocidad` | number | no | speed |
| `mision_id` | string | no | ≤120 |

On success the fix is inserted, the unit's latest position is updated, and the fix is fanned
out to live WebSocket subscribers via the `FlotaTracking` Durable Object (best-effort).

| Status | Body |
|--------|------|
| `200` | `{ "ok": true }` |
| `400` | `{ "error": "unidad_id requerido" }` (no token-derived unit and no body `unidad_id`) |
| `400` | `{ "error": "bad_lat_lon" }` |
| `401` | gate rejects: no operator session and no valid unit token |
| `429` | rate-limit response |

### `GET /api/flota/rastreo/ws` — real-time WebSocket
Operator consoles subscribe to the live position stream. Requires the WebSocket upgrade
handshake; the request is forwarded to the `FlotaTracking` Durable Object (a single
`global`-scoped instance), which fans out every ingested fix to all connected sockets.

- Requires `Upgrade: websocket`. A plain HTTP request → `426 { "error": "expected_websocket" }`.
- Operator/admin session required (the `isFlotaApi` gate; the token carve-out is `posicion`-only).
- Published message shape:
  `{ "type": "posicion", "unidad_id", "lat", "lon", "rumbo", "mision_id", "ts_ms" }`.

Polling GETs below remain a fallback when the socket is unavailable.

### `GET /api/flota/rastreo/unidades`
Latest known position of every unit that has one (map markers). **Rate limited** (120/60 s).

Response: `200 { "results": [ { id, nombre, tipo, estado_op, lat, lon, rumbo, ult_pos_ms }, ... ] }`
(units with `lat IS NOT NULL`, newest fix first, max 1000).

### `GET /api/flota/rastreo/unidad/:id/track`
Recent track points for one unit (polyline trail). **Rate limited** (120/60 s). Query param
`limit` (default `200`, max `1000`).

Response: `200 { "results": [ { lat, lon, rumbo, velocidad, ts_ms }, ... ] }` (newest first).

---

## Tablero (dashboard)

Read-only aggregates powering the operations overview and live command map. Mounted at
`/api/flota/tablero`. (Operator/admin-gated like the rest of the module.)

### `GET /api/flota/tablero/resumen`
Operations summary — one `GROUP BY` pass per table.

Response `200`:
```json
{
  "unidades": { "total": <n>, "por_estado": { "<estado_op>": <n> }, "por_tipo": { "<tipo>": <n> } },
  "misiones": { "total": <n>, "activas": <n>, "por_estado": { "<estado>": <n> }, "por_prioridad": { "<1-5>": <n> } },
  "personal": { "total": <n>, "por_rol": { "<rol>": <n> } },
  "tiempo_respuesta_prom_min": <number|null>,
  "generated_ms": <epoch_ms>
}
```
`misiones.activas` = total missions minus `completada` and `cancelada`.
`tiempo_respuesta_prom_min` is the average `completada_ms − despachada_ms` (in minutes, one
decimal) over completed missions, or `null` if none.

### `GET /api/flota/tablero/mapa`
Everything the live command map needs in one fetch.

Response `200`:
```json
{
  "unidades": [ { id, nombre, tipo, estado_op, lat, lon, ult_pos_ms }, ... ],
  "misiones_activas": [ { id, codigo, tipo, prioridad, estado, unidad_id,
                          origen_lat, origen_lon, destino_lat, destino_lon, descripcion }, ... ],
  "generated_ms": <epoch_ms>
}
```
`unidades` includes only units with both `lat` and `lon`; `misiones_activas` excludes
`completada`/`cancelada`, ordered by `prioridad` then newest (max 1000).

---

## Field-unit token flow

Scoped per-unit bearer tokens let a field GPS device post **its own** position without an
operator session. Defined in `src/lib/flota-token.ts`.

**Token format:** `fbu_<prefix>_<secret>` — `prefix` is 8 hex chars (indexed, non-secret);
`secret` is 32 hex chars. Only the SHA-256 **hash** of the full token is stored; the plaintext
is returned exactly once at issue time. Verification does a constant-time hash compare and
updates `last_used_ms`.

```
 1. Operator issues a token for a unit
    POST /api/flota/unidades/:id/token   (operator/admin session)
        → 201 { token: "fbu_ab12cd34_<secret>", prefix, id, aviso }   ← plaintext shown ONCE

 2. Field device stores the token, then posts GPS fixes with it:
    POST /api/flota/rastreo/posicion
      Authorization: Bearer fbu_ab12cd34_<secret>     (or  X-Unit-Token: fbu_...)
      { "lat": 10.5, "lon": -66.9, "rumbo": 90, "velocidad": 30 }
        → gate calls verifyUnitToken → resolves unidad_id → 200 { ok: true }
          (token's unit overrides any body unidad_id; same-site check bypassed)

 3. Operator can audit / revoke:
    GET    /api/flota/unidades/:id/tokens          → metadata (never the secret)
    DELETE /api/flota/unidades/:id/token/:tokenId  → revoke (sets revoked_ms)
```

Token extraction (`unitTokenFromRequest`) accepts either:
- `Authorization: Bearer fbu_...`, or
- `X-Unit-Token: fbu_...`

A token is rejected (treated as no token) if it is missing, doesn't start with `fbu_`, isn't
3 underscore-delimited parts, is unknown, is revoked, or fails the constant-time hash compare.
A revoked or invalid token on `POST /api/flota/rastreo/posicion` falls through to the
operator/admin gate and yields `401` if no session is present.

---

## Error string reference

| String | Status | Where |
|--------|--------|-------|
| `unauthorized` | 401 | gate — no operator/admin session (JSON routes) |
| `bad_origin` | 403 | gate — authorized but cross-site unsafe method |
| `nombre requerido` / `nombre inválido` | 400 | unidades / personal / flotas |
| `tipo inválido` | 400 | unidades / misiones |
| `estado_op inválido` | 400 | unidades |
| `rol inválido` / `estado inválido` | 400 | personal |
| `nada que actualizar` | 400 | all PATCH endpoints (no recognized fields) |
| `no encontrado` | 404 | resource / sub-resource not found |
| `unidad_en_mision_activa` | 409 | DELETE unidad assigned to a non-terminal mission |
| `unidad no encontrada` / `flota no encontrada` | 404 | add unit to fleet |
| `unidad_id requerido` | 400 | dispatch / add-to-fleet / posicion (operator) |
| `descripcion requerida` | 400 | create mission |
| `bad_origen_lat_lon` / `bad_destino_lat_lon` | 400 | mission coordinates out of range |
| `bad_lat_lon` | 400 | GPS fix coordinates out of range |
| `transicion_invalida` | 409 | illegal mission state transition |
| `unidad_no_encontrada` | 404 | dispatch — assigned unit missing |
| `unidad_no_disponible` | 409 | dispatch — unit not `disponible` (`estado_op` echoed) |
| `estado inválido` | 400 | mission transition / waypoint status |
| `expected_websocket` | 426 | `GET /api/flota/rastreo/ws` without upgrade |
