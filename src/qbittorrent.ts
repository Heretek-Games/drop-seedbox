import { randomInt } from "node:crypto";

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

export interface QbitAddTorrentOptions {
  /** Magnet URI or HTTP(S) URL to a `.torrent` file. */
  url?: string;
  /** Raw `.torrent` file contents to upload. */
  torrentFile?: Uint8Array;
  torrentFileName?: string;
  savePath?: string;
  category?: string;
  paused?: boolean;
}

export interface QbitTransferInfo {
  dl_info_speed: number;
  up_info_speed: number;
  dl_info_data: number;
  up_info_data: number;
  connection_status: string;
  [key: string]: unknown;
}

export type QbitErrorCode =
  | "auth_failed"
  | "http_error"
  | "network_error"
  | "timeout"
  | "invalid_response"
  | "invalid_config";

export interface ParsedQbitBaseUrl {
  ok: true;
  /** Normalized absolute URL without a trailing slash. */
  url: string;
  /** Origin used for the qBittorrent `Origin`/`Referer` CSRF headers. */
  origin: string;
}

export interface InvalidQbitBaseUrl {
  ok: false;
  error: string;
}

/** Opt-in env var that permits loopback seedbox targets: `SEEDBOX_ALLOW_LOOPBACK=true`. */
export const SEEDBOX_ALLOW_LOOPBACK_ENV = "SEEDBOX_ALLOW_LOOPBACK";

export interface QbitHostPolicy {
  /**
   * Permit loopback targets (127.0.0.0/8, ::1, localhost). Defaults to the
   * `SEEDBOX_ALLOW_LOOPBACK=true` environment opt-in. RFC1918 and IPv6 ULA
   * addresses are always allowed so LAN seedboxes keep working.
   */
  allowLoopback?: boolean;
}

export interface ValidQbitHost {
  ok: true;
}

export interface InvalidQbitHost {
  ok: false;
  error: string;
}

function normalizeQbitHostname(hostname: string): string {
  const host = hostname.trim().toLowerCase();
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN,
  );
  if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) {
    return null;
  }
  return octets;
}

/** Expand an IPv6 literal into eight 16-bit groups (IPv4-embedded supported). */
function ipv6Groups(host: string): number[] | null {
  if (!host.includes(":")) return null;
  let address = host;
  const lastColon = host.lastIndexOf(":");
  const lastGroup = lastColon === -1 ? host : host.slice(lastColon + 1);
  if (lastGroup.includes(".")) {
    const octets = ipv4Octets(lastGroup);
    if (!octets) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    address = `${host.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const [headPart, tailPart, ...extra] = address.split("::");
  if (extra.length > 0) return null;
  const parseGroups = (part: string): number[] | null => {
    if (!part) return [];
    const groups = part
      .split(":")
      .map((group) =>
        /^[0-9a-f]{1,4}$/i.test(group)
          ? Number.parseInt(group, 16)
          : Number.NaN,
      );
    return groups.some((group) => Number.isNaN(group)) ? null : groups;
  };
  const head = parseGroups(headPart ?? "");
  if (!head) return null;
  if (tailPart === undefined) return head.length === 8 ? head : null;
  const tail = parseGroups(tailPart);
  if (!tail) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function ipv4MappedOctets(groups: number[]): number[] | null {
  const isMapped =
    groups.length === 8 &&
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff;
  if (!isMapped) return null;
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
}

function isLoopbackHostname(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const octets = ipv4Octets(host);
  if (octets) return octets[0] === 127;
  const groups = ipv6Groups(host);
  if (!groups) return false;
  const mapped = ipv4MappedOctets(groups);
  if (mapped) return mapped[0] === 127;
  return groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
}

function isLinkLocalHostname(host: string): boolean {
  const octets = ipv4Octets(host);
  if (octets) return octets[0] === 169 && octets[1] === 254;
  const groups = ipv6Groups(host);
  if (!groups) return false;
  const mapped = ipv4MappedOctets(groups);
  if (mapped) return mapped[0] === 169 && mapped[1] === 254;
  return (groups[0] & 0xffc0) === 0xfe80;
}

function isUnspecifiedHostname(host: string): boolean {
  const octets = ipv4Octets(host);
  if (octets) return octets.every((octet) => octet === 0);
  const groups = ipv6Groups(host);
  return groups ? groups.every((group) => group === 0) : false;
}

/**
 * Apply the seedbox SSRF host policy. Link-local (cloud metadata) and
 * unspecified targets are always rejected; loopback is rejected unless
 * `policy.allowLoopback` or the `SEEDBOX_ALLOW_LOOPBACK=true` opt-in is set.
 * RFC1918 and IPv6 ULA (fc00::/7) ranges remain allowed: LAN seedboxes are the
 * primary use case.
 */
export function validateQbitHost(
  hostname: string,
  policy: QbitHostPolicy = {},
): ValidQbitHost | InvalidQbitHost {
  const host = normalizeQbitHostname(hostname);
  if (!host) {
    return { ok: false, error: "baseUrl must include a host" };
  }
  if (isLinkLocalHostname(host)) {
    return {
      ok: false,
      error: `baseUrl host "${host}" is a link-local address; metadata endpoints are not allowed`,
    };
  }
  if (isUnspecifiedHostname(host)) {
    return {
      ok: false,
      error: `baseUrl host "${host}" is the unspecified address and is not a valid seedbox target`,
    };
  }
  const allowLoopback =
    policy.allowLoopback ??
    process.env[SEEDBOX_ALLOW_LOOPBACK_ENV]?.trim().toLowerCase() === "true";
  if (!allowLoopback && isLoopbackHostname(host)) {
    return {
      ok: false,
      error: `baseUrl host "${host}" is a loopback address; set ${SEEDBOX_ALLOW_LOOPBACK_ENV}=true to allow loopback seedbox targets`,
    };
  }
  return { ok: true };
}

/**
 * Validate and normalize a qBittorrent base URL. Only absolute `http(s)` URLs
 * are accepted; URLs carrying embedded credentials are rejected so they cannot
 * be silently persisted or leaked via logs. Hosts are checked against the
 * seedbox SSRF policy (loopback, link-local, unspecified).
 */
export function parseQbitBaseUrl(
  raw: unknown,
  policy: QbitHostPolicy = {},
): ParsedQbitBaseUrl | InvalidQbitBaseUrl {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: "baseUrl is required" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, error: "baseUrl must be an absolute http(s) URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "baseUrl must use the http or https scheme" };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error:
        "baseUrl must not contain embedded credentials; use the username/password fields",
    };
  }
  const hostCheck = validateQbitHost(parsed.hostname, policy);
  if (!hostCheck.ok) return hostCheck;
  let url = parsed.toString();
  while (url.endsWith("/")) url = url.slice(0, -1);
  return { ok: true, url, origin: parsed.origin };
}

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
    options.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || !retryable(error)) throw error;
      const base = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const delayMs = options.jitter
        ? Math.round(base * (0.5 + randomInt(0, 1000) / 2000))
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
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly config: QbitConfig) {
    const parsed = parseQbitBaseUrl(config.baseUrl);
    if (!parsed.ok) {
      throw new QBittorrentError(parsed.error, { code: "invalid_config" });
    }
    this.baseUrl = parsed.url;
    this.origin = parsed.origin;
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

  /** Add a torrent from a magnet/URL or raw `.torrent` file. */
  async addTorrent(options: QbitAddTorrentOptions): Promise<void> {
    if (!options.url && !options.torrentFile) {
      throw new QBittorrentError("addTorrent requires a url or torrentFile", {
        code: "invalid_response",
      });
    }
    await withBackoff(() => this.sendTorrentAdd(options), {
      maxRetries: this.maxRetries,
      baseDelayMs: this.backoffBaseMs,
    });
  }

  /** Pause one or more torrents by hash. */
  async pauseTorrents(hashes: string[]): Promise<void> {
    await this.torrentAction("pause", hashes);
  }

  /** Resume one or more torrents by hash. */
  async resumeTorrents(hashes: string[]): Promise<void> {
    await this.torrentAction("resume", hashes);
  }

  /** Delete one or more torrents, optionally removing their data. */
  async deleteTorrents(hashes: string[], deleteFiles = false): Promise<void> {
    if (hashes.length === 0) return;
    const form = new URLSearchParams({ hashes: hashes.join("|") });
    if (deleteFiles) form.set("deleteFiles", "true");
    await withBackoff(
      () =>
        this.send("/api/v2/torrents/delete", {
          method: "POST",
          body: form,
        }),
      { maxRetries: this.maxRetries, baseDelayMs: this.backoffBaseMs },
    );
  }

  /** Global transfer statistics (`/transfer/info`). */
  async getTransferInfo(): Promise<QbitTransferInfo> {
    return withBackoff(
      async () => {
        const payload = await this.getJson<unknown>("/api/v2/transfer/info");
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw new QBittorrentError(
            "qBittorrent returned an unexpected transfer payload",
            { code: "invalid_response" },
          );
        }
        return payload as QbitTransferInfo;
      },
      { maxRetries: this.maxRetries, baseDelayMs: this.backoffBaseMs },
    );
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
    const payload = await this.getJson<unknown>(
      "/api/v2/torrents/info",
      allowRelogin,
    );
    if (!Array.isArray(payload)) {
      throw new QBittorrentError(
        "qBittorrent returned an unexpected torrents payload",
        { code: "invalid_response" },
      );
    }
    return payload as QbitTorrent[];
  }

  private async torrentAction(
    action: "pause" | "resume",
    hashes: string[],
  ): Promise<void> {
    if (hashes.length === 0) return;
    const form = new URLSearchParams({ hashes: hashes.join("|") });
    await withBackoff(
      () =>
        this.send(`/api/v2/torrents/${action}`, {
          method: "POST",
          body: form,
        }),
      { maxRetries: this.maxRetries, baseDelayMs: this.backoffBaseMs },
    );
  }

  private async sendTorrentAdd(options: QbitAddTorrentOptions): Promise<void> {
    if (options.torrentFile) {
      const form = new FormData();
      const bytes = options.torrentFile;
      form.append(
        "torrents",
        new Blob([bytes as BlobPart]),
        options.torrentFileName ?? "upload.torrent",
      );
      if (options.savePath) form.append("savepath", options.savePath);
      if (options.category) form.append("category", options.category);
      if (options.paused) form.append("paused", "true");
      await this.send("/api/v2/torrents/add", { method: "POST", body: form });
      return;
    }

    const form = new URLSearchParams({ urls: options.url ?? "" });
    if (options.savePath) form.set("savepath", options.savePath);
    if (options.category) form.set("category", options.category);
    if (options.paused) form.set("paused", "true");
    await this.send("/api/v2/torrents/add", { method: "POST", body: form });
  }

  /** Authenticated write that re-logs in once on 401/403. */
  private async send(
    path: string,
    init: RequestInit,
    allowRelogin = true,
  ): Promise<void> {
    const res = await this.request(path, init, true);
    if (res.ok) return;
    if (
      (res.status === 401 || res.status === 403) &&
      allowRelogin &&
      this.hasCredentials
    ) {
      this.cookie = null;
      await this.login();
      return this.send(path, init, false);
    }
    throw new QBittorrentError(
      `qBittorrent API error: HTTP ${res.status} ${res.statusText}`.trim(),
      { code: "http_error", status: res.status },
    );
  }

  /** Authenticated JSON read that re-logs in once on 401/403. */
  private async getJson<T>(path: string, allowRelogin = true): Promise<T> {
    const res = await this.request(path, {}, true);
    if (!res.ok) {
      if (
        (res.status === 401 || res.status === 403) &&
        allowRelogin &&
        this.hasCredentials
      ) {
        this.cookie = null;
        await this.login();
        return this.getJson<T>(path, false);
      }
      throw new QBittorrentError(
        `qBittorrent API error: HTTP ${res.status} ${res.statusText}`.trim(),
        { code: "http_error", status: res.status },
      );
    }
    try {
      return (await res.json()) as T;
    } catch (error) {
      throw new QBittorrentError("qBittorrent returned invalid JSON", {
        code: "invalid_response",
        cause: error,
      });
    }
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
    // qBittorrent's WebUI CSRF protection expects Referer/Origin matching the
    // request Host; set them unless the caller overrides them.
    if (!headers.has("origin")) headers.set("origin", this.origin);
    if (!headers.has("referer")) headers.set("referer", `${this.baseUrl}/`);
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
