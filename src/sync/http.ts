/** Small fetch wrapper shared by the connectors: auth headers, timeout, retries with backoff, 429 handling. */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}${body ? `: ${body}` : ""}`);
    this.name = "HttpError";
  }
}

export interface HttpClient {
  json<T = unknown>(url: string, init?: RequestInit): Promise<T>;
  text(url: string, init?: RequestInit): Promise<string>;
  jsonWithHeaders<T = unknown>(url: string, init?: RequestInit): Promise<{ data: T; headers: Headers }>;
}

export interface HttpOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Retries on 429 / 5xx / network errors. */
  retries?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createHttp(opts: HttpOptions = {}): HttpClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 4;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  async function request(url: string, init?: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let delay = Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 250;
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        let res: Response;
        try {
          res = await fetchImpl(url, {
            ...init,
            headers: { accept: "application/json, text/html;q=0.9, */*;q=0.8", ...opts.headers, ...(init?.headers as Record<string, string> | undefined) },
            signal: ac.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (res.ok) return res;
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= retries) {
          throw new HttpError(res.status, url, (await res.text().catch(() => "")).slice(0, 300));
        }
        const retryAfter = Number(res.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) delay = retryAfter * 1000;
        opts.log?.(`  ~ ${res.status} from ${url}; retrying in ${Math.round(delay / 1000)}s`);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (attempt >= retries) throw new Error(`${url}: ${(err as Error).message}`);
        opts.log?.(`  ~ ${(err as Error).message}; retrying ${url}`);
      }
      await sleep(delay);
    }
  }

  return {
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      return (await request(url, init)).json() as Promise<T>;
    },
    async text(url: string, init?: RequestInit): Promise<string> {
      return (await request(url, init)).text();
    },
    async jsonWithHeaders<T>(url: string, init?: RequestInit) {
      const res = await request(url, init);
      return { data: (await res.json()) as T, headers: res.headers };
    },
  };
}

/** Minimal concurrency limiter: `const limit = pLimit(4); await limit(() => fetch(...))`. */
export function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const max = Math.max(1, Math.floor(concurrency));
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(next);
      };
      if (active < max) run();
      else queue.push(run);
    });
}

/** Run `fn` over `items` with bounded concurrency, preserving order of results. */
export async function mapLimit<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const limit = pLimit(concurrency);
  return Promise.all(items.map((item, i) => limit(() => fn(item, i))));
}
