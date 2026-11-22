import { describe, expect, it } from 'vitest';
import { findPhysicalClasses } from './no-physical-tailwind.mjs';

describe('no-physical-tailwind', () => {
  it.each([
    'ml-4',
    'mr-2',
    'pl-3',
    'pr-0',
    'flex -ml-1',
    'md:pr-6',
    'hover:left-0',
    'right-2',
    'text-left',
    'text-right',
    'float-left',
    'border-l',
    'border-r-2',
    'rounded-l',
    'rounded-tr-none',
    'scroll-pl-4',
  ])('flags %s', (cls) => {
    expect(findPhysicalClasses(cls)).not.toHaveLength(0);
  });

  it('reports every physical class in a list', () => {
    expect(findPhysicalClasses('ml-4 ms-2 text-left md:pr-1')).toEqual([
      'ml-4',
      'text-left',
      'md:pr-1',
    ]);
  });

  it.each([
    'ms-4 me-2 ps-3 pe-0',
    'start-0 end-2',
    'text-start text-end',
    'border-s border-e-2',
    'rounded-s rounded-none',
    'border-lime-500',
    'rounded-lg',
    'px-7 py-6',
    'border-b-[6px] pb-1',
    'html-ml',
  ])('allows %s', (cls) => {
    expect(findPhysicalClasses(cls)).toEqual([]);
  });
});
