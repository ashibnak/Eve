import { describe, expect, it } from 'vitest';
import { NO_SCOPE } from './access.service';
import { scopeFilter } from './scoped-prisma';

const companyOnly = { companyField: 'companyId' };
const withUnit = { companyField: 'companyId', unitField: 'unitId' };

describe('scopeFilter', () => {
  it('adds nothing for a customer-wide scope', () => {
    expect(scopeFilter(companyOnly, { ...NO_SCOPE, customerWide: true })).toBeNull();
  });

  it('limits to granted companies', () => {
    expect(scopeFilter(companyOnly, { ...NO_SCOPE, companyIds: new Set(['a']) })).toEqual({
      companyId: { in: ['a'] },
    });
  });

  it('matches nothing for an empty scope', () => {
    expect(scopeFilter(companyOnly, NO_SCOPE)).toEqual({ companyId: { in: [] } });
  });

  it('adds unit subtrees only for models with a unit column', () => {
    const scope = { ...NO_SCOPE, unitIds: new Set(['u1']) };
    expect(scopeFilter(withUnit, scope)).toEqual({
      OR: [{ companyId: { in: [] } }, { unitId: { in: ['u1'] } }],
    });
    expect(scopeFilter(companyOnly, scope)).toEqual({ companyId: { in: [] } });
  });
});
