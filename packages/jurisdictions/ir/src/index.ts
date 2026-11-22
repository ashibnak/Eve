/**
 * Iran jurisdiction pack (ADR-010). Country-specific calendar, legal fields, law,
 * insurance/tax tables and document templates live here, never in modules.
 */
export const jurisdiction = {
  code: 'ir',
} as const;

export type JurisdictionCode = typeof jurisdiction.code;
