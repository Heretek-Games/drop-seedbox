export interface QbitConfig {
  baseUrl: string;
  username?: string;
  password?: string;
  /** Per-request timeout in milliseconds. Defaults to 10_000. */
  timeoutMs?: number;
  /** Extra attempts for retryable failures (timeouts, network errors, 5xx). Defaults to 2. */
  maxRetries?: number;
  /** Base delay for exponential backoff in milliseconds. Defaults to 250. */
  backoffBaseMs?: number;
  /** Injectable fetch implementation (tests, host-provided network egress). */
  fetchFn?: typeof fetch;
}

export interface QbitTorrent {
  hash: string;
  name: string;
  size: number;
  progress: number;
  dlspeed: number;
  state: string;
}

export type QbitErrorCode =
  | "auth_failed"
  | "http_error"
  | "network_error"
  | "timeout"
  | "invalid_response";

export class QBittorrentError extends Error {
  readonly code: QbitErrorCode;
  readonly status?: number;

  constructor(
    message: string,
    options: { code: QbitErrorCode; status?: number; cause?: unknown },
  ) {
    super(
      message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "QBittorrentError";
    this.code = options.code;
    this.status = options.status;
  }
}

export interface QbitConnectionHealth {
  /** The WebUI responded at the HTTP layer. */
  reachable: boolean;
  /** A session cookie was obtained (or auth is bypassed server-side). */
  authenticated: boolean;
  checkedAt: number;
  latencyMs: number;
  error?: string;
}

export interface BackoffOptions {
  /** Extra attempts after the first. Defaults to 2. */
  maxRetries?: number;
  /** First retry delay in ms; doubles per attempt. Defaults to 250. */
  baseDelayMs?: number;
  /** Upper bound for a single delay. Defaults to 5_000. */
  maxDelayMs?: number;
  /** Apply 50-100% jitter to each delay. Defaults to false. */
  jitter?: boolean;
  /** Override retryability classification. */
  isRetryable?: (error: unknown) => boolean;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_BASE_MS = 250;
const DEFAULT_BACKOFF_MAX_MS = 5_000;

export function isRetryableQbitError(error: unknown): boolean {
  if (!(error instanceof QBittorrentError)) return false;
  if (error.code === "timeout" || error.code === "network_error") return true;
  return (
    error.code === "http_error" &&
    typeof error.status === "number" &&
    error.status >= 500
  );
}

/**
 * Run an operation with exponential backoff. Only retryable failures are
 * attempted again; the final error is rethrown unchanged.
 */
export async function withBackoff<T>(
  operation: () => Promise<T>,
  options: BackoffOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BACKOFF_BASE_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_BACKOFF_MAX_MS;
  const retryable = options.isRetryable ?? isRetryableQbitError;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || !retryable(error)) throw error;
      const base = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const delayMs = options.jitter
        ? Math.round(base * (0.5 + Math.random() * 0.5))
        : base;
      options.onRetry?.(error, attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function extractSessionCookie(res: Response): string | null {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const rawCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie") ?? ""];
  for (const raw of rawCookies) {
    const pair = raw.split(";")[0]?.trim();
    if (pair?.startsWith("SID=")) return pair;
  }
  return null;
}

export class QBittorrentClient {
  private cookie: string | null = null;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly config: QbitConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffBaseMs = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  get hasCredentials(): boolean {
    return Boolean(this.config.username && this.config.password);
  }

  get isAuthenticated(): boolean {
    return this.cookie !== null;
  }

  /**
   * Authenticate against the WebUI. Throws a typed `QBittorrentError` when
   * credentials are missing, the HTTP call fails, or the server rejects them.
   * The session cookie is never logged.
   */
  async login(): Promise<void> {
    const { username, password } = this.config;
    if (!username || !password) {
      throw new QBittorrentError(
        "qBittorrent credentials are not configured (username and password are required)",
        { code: "auth_failed" },
      );
    }

    const res = await this.request(
      "/api/v2/auth/login",
      {
        method: "POST",
        body: new URLSearchParams({ username, password }),
      },
      false,
    );

    if (!res.ok) {
      throw new QBittorrentError(
        `qBittorrent login failed with HTTP ${res.status}`,
        { code: "auth_failed", status: res.status },
      );
    }

    const body = (await res.text()).trim();
    if (body !== "Ok.") {
      throw new QBittorrentError(
        "qBittorrent rejected the configured credentials",
        { code: "auth_failed", status: res.status },
      );
    }

    const cookie = extractSessionCookie(res);
    if (!cookie) {
      throw new QBittorrentError(
        "qBittorrent login succeeded without returning a session cookie",
        { code: "invalid_response", status: res.status },
      );
    }
    this.cookie = cookie;
  }

  /** List torrents, retrying transient failures with exponential backoff. */
  async getTorrents(): Promise<QbitTorrent[]> {
    return withBackoff(() => this.fetchTorrents(), {
      maxRetries: this.maxRetries,
      baseDelayMs: this.backoffBaseMs,
    });
  }

  /**
   * Probe the WebUI. Never throws: transport/auth failures are reported in the
   * returned health object.
   */
  async checkHealth(): Promise<QbitConnectionHealth> {
    const checkedAt = Date.now();
    const startedAt = Date.now();
    try {
      const res = await this.request("/api/v2/app/version", {}, true);
      if (res.ok) {
        return {
          reachable: true,
          authenticated: true,
          checkedAt,
          latencyMs: Date.now() - startedAt,
        };
      }
      if ((res.status === 401 || res.status === 403) && this.hasCredentials) {
        await this.login();
        return {
          reachable: true,
          authenticated: true,
          checkedAt,
          latencyMs: Date.now() - startedAt,
        };
      }
      return {
        reachable: true,
        authenticated: false,
        checkedAt,
        latencyMs: Date.now() - startedAt,
        error: `qBittorrent WebUI responded with HTTP ${res.status}`,
      };
    } catch (error) {
      const failure = error instanceof QBittorrentError ? error : undefined;
      return {
        reachable:
          failure?.code !== "timeout" && failure?.code !== "network_error",
        authenticated: false,
        checkedAt,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "unknown error",
      };
    }
  }

  private async fetchTorrents(allowRelogin = true): Promise<QbitTorrent[]> {
    const res = await this.request("/api/v2/torrents/info", {}, true);

    if (!res.ok) {
      if (
        (res.status === 401 || res.status === 403) &&
        allowRelogin &&
        this.hasCredentials
      ) {
        this.cookie = null;
        await this.login();
        return this.fetchTorrents(false);
      }
      throw new QBittorrentError(
        `qBittorrent API error: HTTP ${res.status} ${res.statusText}`.trim(),
        { code: "http_error", status: res.status },
      );
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch (error) {
      throw new QBittorrentError("qBittorrent returned invalid JSON", {
        code: "invalid_response",
        cause: error,
      });
    }
    if (!Array.isArray(payload)) {
      throw new QBittorrentError(
        "qBittorrent returned an unexpected torrents payload",
        { code: "invalid_response" },
      );
    }
    return payload as QbitTorrent[];
  }

  private async request(
    path: string,
    init: RequestInit = {},
    withSession = true,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (withSession && this.cookie) {
      headers.set("cookie", this.cookie);
    }
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw this.toTransportError(error);
    }
  }

  private toTransportError(error: unknown): QBittorrentError {
    const name = (error as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return new QBittorrentError(
        `qBittorrent request timed out after ${this.timeoutMs}ms`,
        { code: "timeout", cause: error },
      );
    }
    return new QBittorrentError("qBittorrent request failed", {
      code: "network_error",
      cause: error,
    });
  }
}
