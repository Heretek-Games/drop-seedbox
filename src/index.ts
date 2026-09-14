import type { PluginContext, ServerPlugin } from "@droposs/plugin-sdk";
import { QBittorrentClient, type QbitConfig } from "./qbittorrent.js";

export * from "./qbittorrent.js";

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
    ],
  };

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
      return { success: true };
    });

    // REST: Query active torrents
    ctx.registerRoute("GET", "/torrents", async () => {
      const config = await ctx.storage.get<QbitConfig>("qbit_config");
      if (!config) {
        return { error: "Seedbox not configured" };
      }
      const client = new QBittorrentClient(config);
      await client.login();
      const torrents = await client.getTorrents();
      return { torrents };
    });

    // WebSocket: Real-time progress channel
    ctx.registerWebSocket("seedbox:progress", (msg, wsCtx) => {
      ctx.logger.info(`Received seedbox WS request from ${wsCtx.userId}`);
      wsCtx.send({ event: "pong", time: Date.now() });
    });
  }

  async teardown(): Promise<void> {
    // Teardown
  }
}
