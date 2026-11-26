import { describe, expect, it } from 'vitest';
import { matchPath } from '../app/router';
import { buildTree, defaultExpanded, layout, NODE_WIDTH } from '../org/chart/layout';
import {
  addDays,
  formatDate,
  formatDateInput,
  parseDateInput,
  todayIso,
  type IsoDate,
} from './format';

describe('dates for people (Jalali in Persian)', () => {
  it('reads what people type: Jalali or ISO, Persian digits, and refuses impossible dates', () => {
    expect(parseDateInput('1405/09/01')).toBe('2026-11-22');
    expect(parseDateInput('۱۴۰۵/۰۹/۰۱')).toBe('2026-11-22');
    expect(parseDateInput('1405-9-1')).toBe('2026-11-22');
    expect(parseDateInput(' 2026-11-22 ')).toBe('2026-11-22');
    expect(parseDateInput('1405/12/31')).toBeNull(); // 1405 is not a leap year
    expect(parseDateInput('2026-02-30')).toBeNull();
    expect(parseDateInput('فردا')).toBeNull();
  });

  it('writes the short Jalali form and the long Persian date', () => {
    expect(formatDateInput('2026-11-22' as IsoDate)).toBe('۱۴۰۵/۰۹/۰۱');
    expect(formatDate('2026-11-22')).toContain('آذر');
    expect(formatDate('2026-11-22')).toContain('۱۴۰۵');
    expect(formatDate(null)).toBe('');
  });

  it('knows today in Tehran and adds days', () => {
    // 21:00 UTC on 21 Nov is already 22 Nov in Tehran (UTC+3:30).
    expect(todayIso(new Date('2026-11-21T21:00:00Z'))).toBe('2026-11-22');
    expect(addDays('2026-11-22' as IsoDate, 10)).toBe('2026-12-02');
  });
});

describe('router', () => {
  it('matches patterns and decodes params', () => {
    expect(matchPath('/positions/:id', '/positions/abc')).toEqual({ id: 'abc' });
    expect(matchPath('/positions/:id', '/positions')).toBeNull();
    expect(matchPath('/changes/new', '/changes/new')).toEqual({});
    expect(matchPath('/changes/:id', '/changes/a%20b')).toEqual({ id: 'a b' });
  });
});

describe('chart tree layout', () => {
  // a ← b, c; b ← d; e is a second root.
  const tree = buildTree([
    { id: 'a', reportsTo: null, order: '0|a' },
    { id: 'b', reportsTo: 'a', order: '0|b' },
    { id: 'c', reportsTo: 'a', order: '1|c' },
    { id: 'd', reportsTo: 'b', order: '1|d' },
    { id: 'e', reportsTo: 'zz', order: '0|e' },
  ]);

  it('finds roots (also positions reporting to a missing one) and depths', () => {
    expect(tree.roots).toEqual(['a', 'e']);
    expect(Object.fromEntries(tree.depth)).toEqual({ a: 0, e: 0, b: 1, c: 1, d: 2 });
  });

  it('opens the top levels by default and centres a manager over its reports, right to left', () => {
    expect([...defaultExpanded(tree, 2)]).toEqual(['a']);
    const placed = layout(tree, defaultExpanded(tree, 2));
    expect(placed.map((n) => n.id)).toEqual(['a', 'b', 'c', 'e']);
    const x = Object.fromEntries(placed.map((n) => [n.id, n.x]));
    expect(x.a).toBe((x.b! + x.c!) / 2);
    // The first report is on the inline-start side: further right (larger x) in RTL.
    expect(x.b!).toBeGreaterThan(x.c!);
    expect(Math.abs(x.b! - x.c!)).toBeGreaterThanOrEqual(NODE_WIDTH);
    expect(placed.find((n) => n.id === 'b')).toMatchObject({ childCount: 1, expanded: false });
  });

  it('survives a cycle in bad data', () => {
    const cyclic = buildTree([
      { id: 'x', reportsTo: 'y', order: 'x' },
      { id: 'y', reportsTo: 'x', order: 'y' },
      { id: 'r', reportsTo: null, order: 'r' },
    ]);
    expect(() => layout(cyclic, new Set(['x', 'y', 'r']))).not.toThrow();
  });
});
