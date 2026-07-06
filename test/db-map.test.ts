// Unit tests for the db-map CREATE TABLE parser (pure part of scripts/db-map.ts).
import { describe, it, expect } from 'vitest';
import { parseCreateTable } from '../scripts/db-map';

describe('parseCreateTable', () => {
  it('parses columns, inline PK, NOT NULL, defaults', () => {
    const p = parseCreateTable(`CREATE TABLE personas (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL DEFAULT '',
      edad INTEGER,
      created_at INTEGER
    )`);
    expect(p.columns.map((c) => c.name)).toEqual(['id', 'nombre', 'edad', 'created_at']);
    expect(p.primaryKey).toEqual(['id']);
    expect(p.columns[1]).toMatchObject({ notNull: true, default: "''" });
    expect(p.columns[2]).toMatchObject({ type: 'INTEGER', notNull: false });
  });

  it('parses table-level PRIMARY KEY, UNIQUE, and FOREIGN KEY', () => {
    const p = parseCreateTable(`CREATE TABLE x (
      a TEXT, b TEXT, c TEXT,
      PRIMARY KEY (a, b),
      UNIQUE (c),
      FOREIGN KEY (b) REFERENCES personas(id)
    )`);
    expect(p.primaryKey).toEqual(['a', 'b']);
    expect(p.uniques).toEqual([['c']]);
    expect(p.foreignKeys).toEqual([{ columns: ['b'], refTable: 'personas', refColumns: ['id'] }]);
  });

  it('handles quoted identifiers and nested parens in types/checks', () => {
    const p = parseCreateTable(`CREATE TABLE "weird" (
      "full name" VARCHAR(120) NOT NULL,
      score NUMERIC(10,2) DEFAULT 0,
      CHECK (score >= 0)
    )`);
    expect(p.columns.map((c) => c.name)).toEqual(['full name', 'score']);
    expect(p.columns[1].default).toBe('0');
  });

  it('handles IF NOT EXISTS and UNIQUE column constraint', () => {
    const p = parseCreateTable(`CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL)`);
    expect(p.columns[1]).toMatchObject({ name: 'code', unique: true, notNull: true });
    expect(p.primaryKey).toEqual(['id']);
  });
});
