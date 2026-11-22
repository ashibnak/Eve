import { describe, expect, it } from 'vitest';
import { compareCatalogs } from './check-keys';

describe('compareCatalogs', () => {
  it('passes identical key sets', () => {
    expect(compareCatalogs({ a: 'x' }, { a: 'y' })).toEqual({ missing: [], extra: [], empty: [] });
  });

  it('reports missing, extra and empty keys', () => {
    expect(compareCatalogs({ a: 'x', b: 'x' }, { a: '', c: 'y' })).toEqual({
      missing: ['b'],
      extra: ['c'],
      empty: ['a'],
    });
  });
});
