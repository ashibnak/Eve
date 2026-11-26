import { type ReactNode, useMemo, useState } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Sort value; without one the column does not sort. */
  sort?: (row: T) => string | number;
  numeric?: boolean;
}

const ROW = 42;
const VISIBLE = 16;

/**
 * The expert's dense table (design system DataTable): navy header, 2px rules, tabular numbers.
 * Only the rows in view are rendered, so 6,000 positions scroll smoothly.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  label,
  onRowClick,
  empty,
}: {
  rows: readonly T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  label: string;
  onRowClick?: (row: T) => void;
  empty: string;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [top, setTop] = useState(0);
  const sorted = useMemo(() => {
    const column = sort && columns.find((c) => c.key === sort.key);
    if (!column?.sort) return rows;
    const by = column.sort;
    return [...rows].sort((a, b) => {
      const x = by(a);
      const y = by(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort!.dir;
    });
  }, [rows, columns, sort]);
  const first = Math.max(0, Math.floor(top / ROW) - 4);
  const last = Math.min(sorted.length, first + VISIBLE + 8);
  const slice = sorted.slice(first, last);

  return (
    <div
      className="max-h-[680px] overflow-auto border-2 border-navy bg-surface"
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
    >
      <table
        aria-label={label}
        aria-rowcount={sorted.length + 1}
        className="w-full border-collapse text-body"
      >
        <thead className="sticky top-0 z-10">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                aria-sort={
                  sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined
                }
                className="whitespace-nowrap bg-navy px-3 py-2 text-start text-label text-cream-on-navy"
              >
                {c.sort ? (
                  <button
                    type="button"
                    className="text-start"
                    onClick={() =>
                      setSort((s) =>
                        s?.key === c.key
                          ? { key: c.key, dir: s.dir === 1 ? -1 : 1 }
                          : { key: c.key, dir: 1 },
                      )
                    }
                  >
                    {c.header}
                  </button>
                ) : (
                  c.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-4 text-ink-muted">
                {empty}
              </td>
            </tr>
          )}
          {first > 0 && <tr aria-hidden="true" style={{ height: first * ROW }} />}
          {slice.map((row, i) => (
            <tr
              key={rowKey(row)}
              aria-rowindex={first + i + 2}
              style={{ height: ROW }}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`border-b-2 border-navy ${onRowClick ? 'cursor-pointer hover:bg-surface-cream' : ''}`}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`px-3 ${c.numeric ? 'whitespace-nowrap tabular-nums' : ''}`}
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
          {last < sorted.length && (
            <tr aria-hidden="true" style={{ height: (sorted.length - last) * ROW }} />
          )}
        </tbody>
      </table>
    </div>
  );
}
