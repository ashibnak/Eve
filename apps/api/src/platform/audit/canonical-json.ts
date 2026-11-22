/**
 * Deterministic JSON for hashing: object keys sorted recursively, no whitespace, bigint as a
 * decimal string, Date as ISO-8601. Values are stored in this form too, so re-reading a row
 * from jsonb and canonicalizing it again yields the same text.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/** The value as it is stored: plain JSON with the same normalization as canonicalJson. */
export function toCanonicalValue<T = unknown>(value: unknown): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Cannot canonicalize non-finite number ${value}`);
    return value;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normalize(v);
    }
    return out;
  }
  return value;
}
