// In-memory D1 test harness backed by better-sqlite3. Implements the subset of
// the D1Database API the FLOTA routes use (prepare/bind/first/all/run/batch) so
// route handlers run real SQL against a real SQLite, applying the actual
// migration files. Used by every test/flota-*.int.test.ts.

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';

// Strip wrangler/D1 migration comments that better-sqlite3 also tolerates.
function applySqlFile(db: Database.Database, path: string) {
  const sql = readFileSync(path, 'utf8');
  db.exec(sql);
}

class Stmt {
  constructor(private db: Database.Database, private sql: string, private args: unknown[] = []) {}
  bind(...args: unknown[]) {
    // D1 accepts undefined for unset optionals; better-sqlite3 requires null.
    return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : a)));
  }
  async first<T = any>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.args as any[]));
    return (row as T) ?? null;
  }
  async all<T = any>(): Promise<{ results: T[]; success: true; meta: any }> {
    const results = this.db.prepare(this.sql).all(...(this.args as any[])) as T[];
    return { results, success: true, meta: {} };
  }
  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const info = this.db.prepare(this.sql).run(...(this.args as any[]));
    return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
  }
}

export class D1Mock {
  constructor(public raw: Database.Database) {}
  prepare(sql: string) {
    return new Stmt(this.raw, sql);
  }
  async batch(stmts: Stmt[]) {
    const tx = this.raw.transaction(() => stmts.map((s) => s.run()));
    return tx();
  }
  async exec(sql: string) {
    this.raw.exec(sql);
    return { count: 0, duration: 0 };
  }
}

export interface TestEnv {
  DB: any;
  CACHE: any;
  [k: string]: any;
}

/** Build a fresh in-memory DB with the given migration files applied. */
export function makeDb(
  migrations: string[] = ['migrations/0037_flota.sql', 'migrations/0045_fleet_live_gps.sql'],
): D1Mock {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  for (const m of migrations) applySqlFile(db, m);
  return new D1Mock(db);
}

/** A minimal env good enough for the FLOTA route handlers. */
export function makeEnv(db: D1Mock): TestEnv {
  const kv = new Map<string, string>();
  return {
    DB: db,
    CACHE: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    },
  };
}

/** Mount one or more route modules on a bare Hono app for direct testing
 *  (bypasses the global index.ts auth gate, which is a separate prefix check). */
export function mount(routes: Array<[string, Hono<any>]>): Hono {
  const app = new Hono();
  for (const [prefix, r] of routes) app.route(prefix, r);
  return app;
}

/** JSON request helper. */
export async function call(
  app: Hono,
  method: string,
  path: string,
  env: TestEnv,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await app.request(path, init, env);
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}
