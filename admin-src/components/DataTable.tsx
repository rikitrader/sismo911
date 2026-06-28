// Generic client-side data table: search, optional filters, row click, skeletons.
import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { Icon } from '../icons';
import { EmptyState, SkeletonRows } from './ui';

export interface Column<T> {
  key: string;
  header: string;
  width?: string;
  render: (row: T) => ComponentChildren;
  align?: 'left' | 'right';
}

interface Filter { label: string; value: string }

export function DataTable<T extends { id: string }>({
  rows, columns, loading, search, searchKeys, onRowClick, filters, filterValue, onFilter,
  emptyTitle = 'Sin resultados', emptyHint, getRowKey,
}: {
  rows: T[];
  columns: Column<T>[];
  loading?: boolean;
  search?: boolean;
  searchKeys?: (keyof T)[];
  onRowClick?: (row: T) => void;
  filters?: Filter[];
  filterValue?: string;
  onFilter?: (v: string) => void;
  emptyTitle?: string;
  emptyHint?: string;
  getRowKey?: (row: T) => string;
}) {
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    if (!q.trim() || !searchKeys) return rows;
    const needle = q.toLowerCase();
    return rows.filter((r) => searchKeys.some((k) => String(r[k] ?? '').toLowerCase().includes(needle)));
  }, [rows, q, searchKeys]);

  return (
    <div class="card overflow-hidden">
      {(search || filters) && (
        <div class="flex items-center gap-2.5 px-3 py-2.5 border-b">
          {search && (
            <div class="relative flex-1 max-w-sm">
              <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none"><Icon.search size={15} /></span>
              <input
                class="input h-8 pl-8 text-[13px]"
                placeholder="Buscar…"
                value={q}
                aria-label="Buscar en la tabla"
                onInput={(e) => setQ((e.target as HTMLInputElement).value)}
              />
            </div>
          )}
          {filters && onFilter && (
            <div class="flex items-center gap-1 ml-auto">
              {filters.map((f) => {
                const on = (filterValue || '') === f.value;
                return (
                  <button
                    key={f.value}
                    class={`btn btn-sm ${on ? 'btn-outline' : 'btn-ghost'}`}
                    aria-pressed={on}
                    onClick={() => onFilter(f.value)}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <SkeletonRows rows={7} cols={Math.min(columns.length, 4)} />
      ) : filtered.length === 0 ? (
        <EmptyState title={q ? 'Sin coincidencias' : emptyTitle} hint={q ? `No hay resultados para “${q}”.` : emptyHint} icon="search" />
      ) : (
        <div class="overflow-x-auto">
          <table class="w-full text-[13px] border-collapse">
            <thead>
              <tr class="surface-subtle">
                {columns.map((c) => (
                  <th
                    key={c.key}
                    class={`label-caps font-semibold px-4 py-2.5 text-left ${c.align === 'right' ? 'text-right' : ''}`}
                    style={c.width ? { width: c.width } : undefined}
                  >
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody class="divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
              {filtered.map((row) => (
                <tr
                  key={getRowKey ? getRowKey(row) : row.id}
                  class={`row-hover transition-colors ${onRowClick ? 'cursor-pointer' : ''}`}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={() => onRowClick?.(row)}
                  onKeyDown={(e) => { if (onRowClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onRowClick(row); } }}
                >
                  {columns.map((c) => (
                    <td key={c.key} class={`px-4 py-2.5 align-middle ${c.align === 'right' ? 'text-right' : ''}`}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
