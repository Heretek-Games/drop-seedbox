import type {
  PluginContext,
  ServerPlugin,
  SubscriptionContext,
} from "@droposs/plugin-sdk";
import {
  QBittorrentClient,
  QBittorrentError,
  parseQbitBaseUrl,
  withBackoff,
  type QbitAddTorrentOptions,
  type QbitConfig,
  type QbitConnectionHealth,
  type QbitErrorCode,
  type QbitTorrent,
  type QbitTransferInfo,
} from "./qbittorrent.js";
import {
  SEEDBOX_CONFIG_KEY_ENV,
  decryptSecret,
  encryptSecret,
  loadConfigKey,
} from "./secrets.js";

export * from "./qbittorrent.js";
export * from "./secrets.js";

export const SEEDBOX_PROGRESS_CHANNEL = "seedbox:progress";
export const DEFAULT_PROGRESS_INTERVAL_MS = 15_000;

/** Minimal surface the plugin needs from a qBittorrent client (mockable). */
export interface SeedboxClient {
  login(): Promise<void>;
  getTorrents(): Promise<QbitTorrent[]>;
  addTorrent?(options: QbitAddTorrentOptions): Promise<void>;
  pauseTorrents?(hashes: string[]): Promise<void>;
  resumeTorrents?(hashes: string[]): Promise<void>;
  deleteTorrents?(hashes: string[], deleteFiles?: boolean): Promise<void>;
  getTransferInfo?(): Promise<QbitTransferInfo>;
  checkHealth?(): Promise<QbitConnectionHealth>;
}

/** A registered remote/seedbox depot endpoint. */
export interface SeedboxDepot {
  id: string;
  endpoint: string;
  enabled: boolean;
  /** Lower values are preferred by the client. */
  priority: number;
  updatedAt: number;
}

export const SEEDBOX_DEPOTS_KEY = "seedbox:depots";

/** A seedbox torrent associated with a Drop game. */
export interface SeedboxGameMapping {
  gameId: string;
  hash?: string;
  contentPath?: string;
  updatedAt: number;
}

export const SEEDBOX_MAPPING_GAME_PREFIX = "mapping:game:";
export const SEEDBOX_MAPPING_HASH_PREFIX = "mapping:hash:";

export type QbitApiErrorCode =
  | QbitErrorCode
  | "not_configured"
  | "unauthorized"
  | "unknown";

export interface QbitApiError {
  error: string;
  code: QbitApiErrorCode;
}

export interface QbitTorrentsResponse {
  torrents: QbitTorrent[];
}

export interface SeedboxPluginOptions {
  /** Injectable client factory (tests, custom transports). */
  clientFactory?: (config: QbitConfig) => SeedboxClient;
  /** Progress broadcast cadence in ms. Defaults to 15s. */
  progressIntervalMs?: number;
}

interface SeedboxProgressEvent {
  event: "progress";
  torrents: QbitTorrent[];
  time: number;
}

interface SeedboxErrorEvent extends QbitApiError {
  event: "error";
  time: number;
}

async function getRequestBody<T = any>(event: any): Promise<T> {
  if (event && event.body !== undefined) {
    return event.body;
  }
  try {
    // @ts-ignore
    const h3 = await import("h3").catch(() => null);
    if (h3?.readBody) {
      return (await h3.readBody(event)) || ({} as T);
    }
    return (event?.body || {}) as T;
  } catch {
    return (event?.body || {}) as T;
  }
}

/** Read the configured remote depot endpoints. */
async function readDepots(ctx: PluginContext): Promise<SeedboxDepot[]> {
  return (await ctx.storage.get<SeedboxDepot[]>(SEEDBOX_DEPOTS_KEY)) ?? [];
}

/** Persisted config shape: the password may be stored as ciphertext. */
interface StoredQbitConfig extends QbitConfig {
  credentialsEncrypted?: boolean;
}

const CONFIG_KEY = "qbit_config";

/**
 * Load the persisted qBittorrent config, decrypting the password when it was
 * stored encrypted. Legacy plaintext passwords are re-sealed in storage when an
 * encryption key is configured so upgrades migrate without a re-save. Returns a
 * typed error instead of throwing so route handlers can report it.
 */
async function resolveQbitConfig(
  ctx: PluginContext,
): Promise<QbitConfig | QbitApiError> {
  const stored = await ctx.storage.get<StoredQbitConfig>(CONFIG_KEY);
  if (!stored) {
    return { error: "Seedbox not configured", code: "not_configured" };
  }

  const { credentialsEncrypted: _flag, ...storedConfig } = stored;
  let resolved: QbitConfig = storedConfig;

  if (!stored.credentialsEncrypted) {
    if (stored.password) {
      let key: ReturnType<typeof loadConfigKey>;
      try {
        key = loadConfigKey();
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : "Invalid seedbox key",
          code: "invalid_config",
        };
      }
      if (key) {
        await ctx.storage.set(CONFIG_KEY, {
          ...storedConfig,
          password: encryptSecret(stored.password, key),
          credentialsEncrypted: true,
        });
        ctx.logger.info(
          "Migrated legacy plaintext seedbox credentials to encrypted storage",
        );
      }
    }
  } else {
    let key: ReturnType<typeof loadConfigKey>;
    try {
      key = loadConfigKey();
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Invalid seedbox key",
        code: "invalid_config",
      };
    }
    if (!key) {
      return {
        error: `Seedbox credentials are encrypted; set ${SEEDBOX_CONFIG_KEY_ENV} to decrypt them`,
        code: "invalid_config",
      };
    }
    try {
      resolved = {
        ...storedConfig,
        password: storedConfig.password
          ? decryptSecret(storedConfig.password, key)
          : undefined,
      };
    } catch {
      return {
        error: "Unable to decrypt stored seedbox credentials",
        code: "invalid_config",
      };
    }
  }

  const parsed = parseQbitBaseUrl(resolved.baseUrl);
  if (!parsed.ok) {
    return { error: parsed.error, code: "invalid_config" };
  }
  return { ...resolved, baseUrl: parsed.url };
}

export default class SeedboxPlugin implements ServerPlugin {  metadata = {
    id: "drop-seedbox",
    name: "Seedbox & qBittorrent Depot Provider",
    version: "0.1.0",
    apiVersion: 2,
    capabilities: [
      "routes" as const,
      "storage" as const,
      "network" as const,
      "websocket" as const,
      "events" as const,
    ],
  };

  private readonly clientFactory: (config: QbitConfig) => SeedboxClient;
  private readonly progressIntervalMs: number;
  private readonly subscribers = new Set<string>();
  private progressTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SeedboxPluginOptions = {}) {
    this.progressIntervalMs =
      options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.clientFactory =
      options.clientFactory ?? ((config) => new QBittorrentClient(config));
  }

  async init(ctx: PluginContext): Promise<void> {
    ctx.logger.info("Initializing Seedbox & qBittorrent plugin...");

    // REST: Configure seedbox credentials
    ctx.registerRoute("POST", "/config", async (event, routeCtx) => {
      if (!routeCtx.userId) {
        return {
          error: "Authentication required to configure seedbox",
          code: "unauthorized" as const,
        };
      }
      const config = ((await getRequestBody<QbitConfig>(event)) ||
        {}) as QbitConfig;
      const parsed = parseQbitBaseUrl(config.baseUrl);
      if (!parsed.ok) {
        return { error: parsed.error, code: "invalid_config" as const };
      }
      const stored: StoredQbitConfig = { ...config, baseUrl: parsed.url };
      if (config.password) {
        let key: ReturnType<typeof loadConfigKey>;
        try {
          key = loadConfigKey();
        } catch (error) {
          return {
            error:
              error instanceof Error
                ? error.message
                : "Invalid seedbox encryption key",
            code: "invalid_config" as const,
          };
        }
        if (!key) {
          return {
            error: `Refusing to persist the qBittorrent password in plaintext; set ${SEEDBOX_CONFIG_KEY_ENV} to store it encrypted`,
            code: "invalid_config" as const,
          };
        }
        stored.password = encryptSecret(config.password, key);
        stored.credentialsEncrypted = true;
      }
      await ctx.storage.set(CONFIG_KEY, stored);
      // Credentials changed: drop any cached session used by progress polling.
      this.resetProgressPolling();
      return { success: true };
    });

    // REST: Query active torrents
    ctx.registerRoute(
      "GET",
      "/torrents",
      async (_event, routeCtx): Promise<QbitTorrentsResponse | QbitApiError> => {
        if (!routeCtx.userId) {
          return {
            error: "Authentication required to view torrents",
            code: "unauthorized",
          };
        }
        const config = await resolveQbitConfig(ctx);
        if ("error" in config) {
          return config;
        }
        try {
          const client = this.clientFactory(config);
          await client.login();
          const torrents = await withBackoff(() => client.getTorrents(), {
            maxRetries: config.maxRetries,
            baseDelayMs: config.backoffBaseMs,
          });
          return { torrents };
        } catch (error) {
          return this.toApiError(error, ctx, "GET /torrents");
        }
      },
    );

    // REST: Add a torrent (magnet/URL or base64 .torrent) — admin only
    ctx.registerRoute("POST", "/torrents", async (event, routeCtx) => {
      if (!routeCtx.userId) {
        return { error: "Authentication required to add torrents" };
      }
      const body = ((await getRequestBody(event)) || {}) as {
        url?: string;
        torrentFile?: string;
        torrentFileName?: string;
        savePath?: string;
        category?: string;
        paused?: boolean;
      };

      let torrentFile: Uint8Array | undefined;
      if (body.torrentFile) {
        try {
          torrentFile = Buffer.from(body.torrentFile, "base64");
        } catch {
          return { error: "torrentFile must be base64-encoded" };
        }
        if (torrentFile.length === 0) {
          return { error: "torrentFile must not be empty" };
        }
      }
      if (!body.url && !torrentFile) {
        return { error: "url or torrentFile is required" };
      }

      return this.runWithClient(ctx, "POST /torrents", async (client) => {
        if (!client.addTorrent) {
          return { error: "Client does not support adding torrents" };
        }
        await client.addTorrent({
          url: body.url,
          torrentFile,
          torrentFileName: body.torrentFileName,
          savePath: body.savePath,
          category: body.category,
          paused: body.paused,
        });
        return { success: true };
      });
    });

    // REST: Pause/resume/delete a torrent by hash — admin only
    ctx.registerRoute("POST", "/torrents/:hash/pause", async (_event, routeCtx) =>
      this.mutateTorrent(ctx, routeCtx, "pause"),
    );
    ctx.registerRoute("POST", "/torrents/:hash/resume", async (_event, routeCtx) =>
      this.mutateTorrent(ctx, routeCtx, "resume"),
    );
    ctx.registerRoute("DELETE", "/torrents/:hash", async (event, routeCtx) => {
      if (!routeCtx.userId) {
        return { error: "Authentication required to delete torrents" };
      }
      const hash = routeCtx.params.hash;
      if (!hash) return { error: "hash is required" };
      const body = ((await getRequestBody(event)) || {}) as {
        deleteFiles?: boolean;
      };
      return this.runWithClient(ctx, "DELETE /torrents", async (client) => {
        if (!client.deleteTorrents) {
          return { error: "Client does not support deleting torrents" };
        }
        await client.deleteTorrents([hash], Boolean(body.deleteFiles));
        return { success: true };
      });
    });

    // REST: Global transfer statistics
    ctx.registerRoute("GET", "/transfer", async (_event, routeCtx) => {
      if (!routeCtx.userId) {
        return {
          error: "Authentication required to view transfer stats",
          code: "unauthorized" as const,
        };
      }
      return this.runWithClient(ctx, "GET /transfer", async (client) => {
        if (!client.getTransferInfo) {
          return { error: "Client does not support transfer stats" };
        }
        return { transfer: await client.getTransferInfo() };
      });
    });

    // REST: Connection health (never throws; reports reachability/auth)
    ctx.registerRoute("GET", "/health", async (_event, routeCtx) => {
      if (!routeCtx.userId) {
        return {
          error: "Authentication required to view seedbox health",
          code: "unauthorized" as const,
        };
      }
      try {
        const config = await resolveQbitConfig(ctx);
        if ("error" in config) {
          // A configured-but-invalid URL is reported in the health shape so
          // this route never throws; not-configured/decrypt errors stay typed.
          if (config.code !== "invalid_config") {
            return config;
          }
          return this.healthUnreachable(config.error);
        }
        const client = this.clientFactory(config);
        if (client.checkHealth) {
          return { health: await client.checkHealth() };
        }
        await client.login();
        return {
          health: {
            reachable: true,
            authenticated: true,
            checkedAt: Date.now(),
            latencyMs: 0,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        ctx.logger.warn(`GET /health failed: ${message}`);
        return this.healthUnreachable(message);
      }
    });

    // REST: registered remote/seedbox depot endpoints (admin, lowest priority first)
    ctx.registerRoute("GET", "/depots", async (_event, routeCtx) => {
      if (!routeCtx.userId) {
        return { error: "Authentication required to view depots" };
      }
      const depots = await readDepots(ctx);
      depots.sort((a, b) => a.priority - b.priority);
      return { depots, count: depots.length };
    });

    ctx.registerRoute("POST", "/depots", async (event, routeCtx) => {
      if (!routeCtx.userId) {
        return { error: "Authentication required to configure depots" };
      }
      const body = ((await getRequestBody(event)) || {}) as Partial<SeedboxDepot>;
      if (!body.id || !body.endpoint) {
        return { error: "id and endpoint are required" };
      }
      const priority =
        typeof body.priority === "number" &&
        Number.isInteger(body.priority) &&
        body.priority >= 0
          ? body.priority
          : 100;
      const depot: SeedboxDepot = {
        id: body.id,
        endpoint: body.endpoint,
        enabled: body.enabled ?? true,
        priority,
        updatedAt: Date.now(),
      };
      const depots = (await readDepots(ctx)).filter((entry) => entry.id !== depot.id);
      depots.push(depot);
      await ctx.storage.set(SEEDBOX_DEPOTS_KEY, depots);
      return { success: true, depot };
    });

    ctx.registerRoute("DELETE", "/depots/:id", async (_event, routeCtx) => {
      if (!routeCtx.userId) {
        return { error: "Authentication required to configure depots" };
      }
      const id = routeCtx.params.id;
      if (!id) return { error: "id is required" };
      const depots = await readDepots(ctx);
      const next = depots.filter((entry) => entry.id !== id);
      await ctx.storage.set(SEEDBOX_DEPOTS_KEY, next);
      return { success: true, removed: depots.length - next.length };
    });

    // REST: Associate a torrent/hash or content path with a Drop game
    ctx.registerRoute("POST", "/mappings", async (event, routeCtx) => {
      if (!routeCtx.userId) {
        return { error: "Authentication required to configure mappings" };
      }
      const body = ((await getRequestBody(event)) || {}) as Partial<SeedboxGameMapping>;
      if (!body.gameId) {
        return { error: "gameId is required" };
      }
      if (!body.hash && !body.contentPath) {
        return { error: "hash or contentPath is required" };
      }
      const mapping: SeedboxGameMapping = {
        gameId: body.gameId,
        hash: body.hash,
        contentPath: body.contentPath,
        updatedAt: Date.now(),
      };
      await ctx.storage.set(
        `${SEEDBOX_MAPPING_GAME_PREFIX}${mapping.gameId}`,
        mapping,
      );
      if (mapping.hash) {
        await ctx.storage.set(
          `${SEEDBOX_MAPPING_HASH_PREFIX}${mapping.hash}`,
          mapping,
        );
      }
      return { success: true, mapping };
    });

    // REST: Look up the game mapped to a hash
    ctx.registerRoute(
      "GET",
      "/mappings",
      async (
        _event,
        routeCtx,
      ): Promise<{ mapping: SeedboxGameMapping | null } | QbitApiError> => {
        if (!routeCtx.userId) {
          return {
            error: "Authentication required to view mappings",
            code: "unauthorized",
          };
        }
        const hash = routeCtx.query?.hash;
        if (!hash) return { mapping: null };
        const mapping =
          (await ctx.storage.get<SeedboxGameMapping>(
            `${SEEDBOX_MAPPING_HASH_PREFIX}${hash}`,
          )) ?? null;
        return { mapping };
      },
    );

    // REST: Look up a game's stored mapping
    ctx.registerRoute(
      "GET",
      "/mappings/:gameId",
      async (
        _event,
        routeCtx,
      ): Promise<{ mapping: SeedboxGameMapping | null } | QbitApiError> => {
        if (!routeCtx.userId) {
          return {
            error: "Authentication required to view mappings",
            code: "unauthorized",
          };
        }
        const mapping =
          (await ctx.storage.get<SeedboxGameMapping>(
            `${SEEDBOX_MAPPING_GAME_PREFIX}${routeCtx.params.gameId}`,
          )) ?? null;
        return { mapping };
      },
    );

    // WebSocket: only authenticated users may subscribe to progress updates.
    ctx.registerSubscriptionAuthorizer(
      (channel) => channel === SEEDBOX_PROGRESS_CHANNEL,
      (_channel, context: SubscriptionContext) => Boolean(context.userId),
    );

    // WebSocket: Real-time progress channel. A client sends { type: "subscribe" }
    // (or any message) to receive an immediate snapshot plus periodic updates,
    // { type: "unsubscribe" } to stop, and { type: "ping" } for liveness.
    ctx.registerWebSocket(SEEDBOX_PROGRESS_CHANNEL, async (msg, wsCtx) => {
      if (!wsCtx.userId) {
        wsCtx.send({
          event: "error",
          error: "Authentication required to subscribe to seedbox progress",
          code: "unauthorized",
          time: Date.now(),
        });
        return;
      }

      const message = (msg ?? {}) as { type?: string };
      if (message.type === "ping") {
        wsCtx.send({ event: "pong", time: Date.now() });
        return;
      }
      if (message.type === "unsubscribe") {
        this.subscribers.delete(wsCtx.userId);
        this.stopProgressPollingIfIdle();
        wsCtx.send({ event: "unsubscribed", time: Date.now() });
        return;
      }

      this.subscribers.add(wsCtx.userId);
      await this.sendProgressSnapshot(ctx, wsCtx.send);
      this.startProgressPolling(ctx);
    });
  }

  async teardown(): Promise<void> {
    this.resetProgressPolling();
  }

  /** Build a logged-in client or return a typed "not configured" error. */
  private async runWithClient<T>(
    ctx: PluginContext,
    context: string,
    operation: (client: SeedboxClient, config: QbitConfig) => Promise<T>,
  ): Promise<T | QbitApiError> {
    const config = await resolveQbitConfig(ctx);
    if ("error" in config) {
      return config;
    }
    try {
      const client = this.clientFactory(config);
      await client.login();
      return await operation(client, config);
    } catch (error) {
      return this.toApiError(error, ctx, context);
    }
  }

  private async mutateTorrent(
    ctx: PluginContext,
    routeCtx: { params: Record<string, string>; userId?: string },
    action: "pause" | "resume",
  ): Promise<unknown> {
    if (!routeCtx.userId) {
      return { error: `Authentication required to ${action} torrents` };
    }
    const hash = routeCtx.params.hash;
    if (!hash) return { error: "hash is required" };
    return this.runWithClient(ctx, `POST /torrents/${action}`, async (client) => {
      const method = action === "pause" ? client.pauseTorrents : client.resumeTorrents;
      if (!method) {
        return { error: `Client does not support ${action} torrents` };
      }
      await method.call(client, [hash]);
      return { success: true as const };
    });
  }

  private async sendProgressSnapshot(
    ctx: PluginContext,
    send: (data: unknown) => void,
  ): Promise<void> {
    const config = await resolveQbitConfig(ctx);
    if ("error" in config) {
      send(this.errorEvent(config));
      return;
    }
    try {
      const client = this.clientFactory(config);
      await client.login();
      const torrents = await withBackoff(() => client.getTorrents(), {
        maxRetries: config.maxRetries,
        baseDelayMs: config.backoffBaseMs,
        jitter: true,
      });
      send(this.progressEvent(torrents));
    } catch (error) {
      send(this.errorEvent(this.toApiError(error, ctx, "seedbox:progress")));
    }
  }

  private startProgressPolling(ctx: PluginContext): void {
    if (this.progressTimer || this.subscribers.size === 0) return;
    this.progressTimer = setInterval(() => {
      void this.broadcastProgress(ctx);
    }, this.progressIntervalMs);
    this.progressTimer.unref?.();
  }

  private async broadcastProgress(ctx: PluginContext): Promise<void> {
    if (this.subscribers.size === 0) {
      this.stopProgressPollingIfIdle();
      return;
    }
    const config = await resolveQbitConfig(ctx);
    if ("error" in config) {
      ctx.broadcast(SEEDBOX_PROGRESS_CHANNEL, this.errorEvent(config));
      return;
    }
    try {
      const client = this.clientFactory(config);
      await client.login();
      const torrents = await withBackoff(() => client.getTorrents(), {
        maxRetries: config.maxRetries,
        baseDelayMs: config.backoffBaseMs,
        jitter: true,
        onRetry: (error, attempt, delayMs) => {
          ctx.logger.warn(
            `seedbox:progress poll retry ${attempt} in ${delayMs}ms: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          );
        },
      });
      ctx.broadcast(SEEDBOX_PROGRESS_CHANNEL, this.progressEvent(torrents));
    } catch (error) {
      ctx.broadcast(
        SEEDBOX_PROGRESS_CHANNEL,
        this.errorEvent(this.toApiError(error, ctx, "seedbox:progress poll")),
      );
    }
  }

  private stopProgressPollingIfIdle(): void {
    if (this.subscribers.size === 0 && this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  private resetProgressPolling(): void {
    this.subscribers.clear();
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  private progressEvent(torrents: QbitTorrent[]): SeedboxProgressEvent {
    return { event: "progress", torrents, time: Date.now() };
  }

  private errorEvent(error: QbitApiError): SeedboxErrorEvent {
    return { event: "error", ...error, time: Date.now() };
  }

  private healthUnreachable(error: string): { health: QbitConnectionHealth } {
    return {
      health: {
        reachable: false,
        authenticated: false,
        checkedAt: Date.now(),
        latencyMs: 0,
        error,
      },
    };
  }

  private toApiError(
    error: unknown,
    ctx: PluginContext,
    context: string,
  ): QbitApiError {
    if (error instanceof QBittorrentError) {
      const status = error.status ? `, status=${error.status}` : "";
      // Error messages never include credentials or session cookies.
      ctx.logger.error(
        `${context} failed: ${error.message} (code=${error.code}${status})`,
      );
      return { error: error.message, code: error.code };
    }
    ctx.logger.error(
      `${context} failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return { error: "Unexpected seedbox error", code: "unknown" };
  }
}
