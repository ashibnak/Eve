/** Minimal JSON client for /api/v1. The session lives in an httpOnly cookie the browser sends. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`API ${status}${code ? ` ${code}` : ''}`);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin' };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`/api/v1${path}`, init);
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const code = (data as { error?: unknown } | null)?.error;
    throw new ApiError(res.status, typeof code === 'string' ? code : undefined);
  }
  return data as T;
}

export interface Me {
  id: string;
  username: string;
  roles: { role: string; scopeKind: string; companyId: string | null }[];
}

/** Persian and Arabic-Indic digits typed into a code field become ASCII digits. */
export function toAsciiDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}
