import type {
  PluginContext,
  ServerPlugin,
  SubscriptionContext,
} from "@droposs/plugin-sdk";
import {
  QBittorrentClient,
  QBittorrentError,
  withBackoff,
  type QbitConfig,
  type QbitErrorCode,
  type QbitTorrent,
} from "./qbittorrent.js";

export * from "./qbittorrent.js";

export const SEEDBOX_PROGRESS_CHANNEL = "seedbox:progress";
export const DEFAULT_PROGRESS_INTERVAL_MS = 15_000;

/** Minimal surface the plugin needs from a qBittorrent client (mockable). */
export interface SeedboxClient {
  login(): Promise<void>;
  getTorrents(): Promise<QbitTorrent[]>;
}

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

export default class SeedboxPlugin implements ServerPlugin {
  metadata = {
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
        return { error: "Authentication required to configure seedbox" };
      }
      const config = ((await getRequestBody<QbitConfig>(event)) ||
        {}) as QbitConfig;
      if (!config.baseUrl) {
        return { error: "baseUrl is required" };
      }
      await ctx.storage.set("qbit_config", config);
      // Credentials changed: drop any cached session used by progress polling.
      this.resetProgressPolling();
      return { success: true };
    });

    // REST: Query active torrents
    ctx.registerRoute(
      "GET",
      "/torrents",
      async (): Promise<QbitTorrentsResponse | QbitApiError> => {
        const config = await ctx.storage.get<QbitConfig>("qbit_config");
        if (!config) {
          return { error: "Seedbox not configured", code: "not_configured" };
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

  private async sendProgressSnapshot(
    ctx: PluginContext,
    send: (data: unknown) => void,
  ): Promise<void> {
    const config = await ctx.storage.get<QbitConfig>("qbit_config");
    if (!config) {
      send(this.errorEvent({ error: "Seedbox not configured", code: "not_configured" }));
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
    const config = await ctx.storage.get<QbitConfig>("qbit_config");
    if (!config) {
      ctx.broadcast(
        SEEDBOX_PROGRESS_CHANNEL,
        this.errorEvent({ error: "Seedbox not configured", code: "not_configured" }),
      );
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
