import { redact } from "./redact.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly method: string, public readonly path: string, body: string) {
    super(`${method} ${path} failed with HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

export interface HttpClientOptions {
  baseUrl: string;
  /** Headers sent on every request, e.g. { Authorization: `Bearer ${key}` }. */
  headers?: Record<string, string>;
  /** Secret values to strip from error text. */
  secrets?: string[];
  timeoutMs?: number;
  /** Retries for 429 and 5xx responses on idempotent requests (GET, PUT, DELETE). */
  retries?: number;
  /** Injected in tests. */
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

const IDEMPOTENT = new Set(["GET", "PUT", "DELETE", "HEAD"]);

/** Small JSON API client: timeout, retry with backoff, and secrets kept out of errors. */
export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: HttpClientOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(path.replace(/^\//, ""), this.options.baseUrl.replace(/\/?$/, "/"));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const attempts = IDEMPOTENT.has(method.toUpperCase()) ? (this.options.retries ?? 2) + 1 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await this.fetchImpl(url.toString(), {
          method,
          headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...this.options.headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
        });
        const text = await response.text();
        if (response.ok) return (text ? JSON.parse(text) : null) as T;
        const error = new HttpError(response.status, method, url.pathname, this.clean(text));
        if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
          const retryAfter = Number(response.headers.get("retry-after"));
          await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** (attempt - 1));
          lastError = error;
          continue;
        }
        throw error;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        lastError = new Error(this.clean(`${method} ${url.pathname} failed: ${(error as Error).message}`));
        if (attempt < attempts) await this.sleep(250 * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }

  get<T = unknown>(path: string, query?: Record<string, string | number | undefined>) { return this.request<T>("GET", path, undefined, query); }
  post<T = unknown>(path: string, body?: unknown) { return this.request<T>("POST", path, body); }
  put<T = unknown>(path: string, body?: unknown) { return this.request<T>("PUT", path, body); }
  delete<T = unknown>(path: string) { return this.request<T>("DELETE", path); }

  private clean(text: string): string {
    return redact(text, [...(this.options.secrets ?? []), ...Object.values(this.options.headers ?? {})]);
  }
}
