/** Shared by HTTP integration tests (platform and packs). */
/** A minimal cookie-keeping HTTP client for one user. */
export class HttpTestClient {
  private cookie = '';

  get cookieHeader(): string {
    return this.cookie;
  }

  constructor(private readonly base: string) {}

  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.base}/api/v1${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0] ?? '';
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null, setCookie };
  }

  /** Multipart upload with the session cookie. */
  async upload(
    path: string,
    fields: Record<string, string>,
    file: { name: string; content: Buffer },
  ) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append('file', new Blob([new Uint8Array(file.content)]), file.name);
    const res = await fetch(`${this.base}/api/v1${path}`, {
      method: 'POST',
      headers: this.cookie ? { cookie: this.cookie } : {},
      body: form,
    });
    return { status: res.status, body: (await res.json()) as unknown };
  }
}
