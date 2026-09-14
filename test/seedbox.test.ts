import { test } from "node:test";
import assert from "node:assert/strict";
import { MockPluginContext } from "@droposs/plugin-sdk";
import SeedboxPlugin, {
  SEEDBOX_PROGRESS_CHANNEL,
  type SeedboxClient,
} from "../src/index.js";
import { QBittorrentError, type QbitTorrent } from "../src/qbittorrent.js";

const TORRENTS: QbitTorrent[] = [
  {
    hash: "abc123",
    name: "Example Game",
    size: 1_000,
    progress: 0.25,
    dlspeed: 128,
    state: "downloading",
  },
];

const CONFIG = {
  baseUrl: "http://qbit.local:8080",
  username: "admin",
  password: "password123",
};

interface PluginOptions {
  client?: SeedboxClient;
  progressIntervalMs?: number;
}

function makeCtx(): MockPluginContext {
  return new MockPluginContext("drop-seedbox", [
    "routes",
    "storage",
    "network",
    "websocket",
    "events",
  ]);
}

function fakeClient(options: {
  torrents?: QbitTorrent[];
  loginError?: Error;
  torrentsError?: Error;
} = {}): SeedboxClient {
  return {
    async login(): Promise<void> {
      if (options.loginError) throw options.loginError;
    },
    async getTorrents(): Promise<QbitTorrent[]> {
      if (options.torrentsError) throw options.torrentsError;
      return options.torrents ?? TORRENTS;
    },
  };
}

function makePlugin(options: PluginOptions = {}): SeedboxPlugin {
  return new SeedboxPlugin({
    clientFactory: () => options.client ?? fakeClient(),
    progressIntervalMs: options.progressIntervalMs ?? 60_000,
  });
}

async function makeRouteHarness(options: PluginOptions = {}) {
  const plugin = makePlugin(options);
  const ctx = makeCtx();
  await plugin.init(ctx);
  const route = ctx.routes.get("GET /torrents");
  assert.ok(route, "GET /torrents must be registered");
  return { plugin, ctx, handler: route.handler };
}

interface WsHarness {
  plugin: SeedboxPlugin;
  ctx: MockPluginContext;
  sent: any[];
  invoke(msg: unknown, userId?: string | null): Promise<void>;
}

async function makeWsHarness(
  options: PluginOptions & { configured?: boolean } = {},
): Promise<WsHarness> {
  const plugin = makePlugin(options);
  const ctx = makeCtx();
  await plugin.init(ctx);
  if (options.configured) {
    await ctx.storage.set("qbit_config", { ...CONFIG });
  }
  const progressWs = ctx.wsHandlers.get(SEEDBOX_PROGRESS_CHANNEL);
  assert.ok(progressWs, "seedbox:progress websocket handler must be registered");
  const sent: any[] = [];
  const send = (data: unknown) => {
    sent.push(data);
  };
  return {
    plugin,
    ctx,
    sent,
    invoke: async (msg, userId: string | null = "admin-1") => {
      await progressWs(msg, { userId: userId ?? undefined, send });
    },
  };
}

test("SeedboxPlugin registers routes/WS/authorizers and enforces auth on config", async () => {
  const plugin = makePlugin();
  const ctx = makeCtx();
  await plugin.init(ctx);

  const configRoute = ctx.routes.get("POST /config");
  assert.ok(configRoute, "POST /config must be registered");

  const torrentsRoute = ctx.routes.get("GET /torrents");
  assert.ok(torrentsRoute, "GET /torrents must be registered");

  assert.ok(
    ctx.wsHandlers.get(SEEDBOX_PROGRESS_CHANNEL),
    "seedbox:progress websocket handler must be registered",
  );

  assert.equal(ctx.authorizers.length, 1, "a subscription authorizer is registered");
  const authorizer = ctx.authorizers[0];
  assert.equal(authorizer.matches(SEEDBOX_PROGRESS_CHANNEL), true);
  assert.equal(authorizer.matches("other:channel"), false);
  assert.equal(
    await authorizer.auth(SEEDBOX_PROGRESS_CHANNEL, {
      userId: undefined,
      userAcls: undefined,
    }),
    false,
  );
  assert.equal(
    await authorizer.auth(SEEDBOX_PROGRESS_CHANNEL, {
      userId: "admin-1",
      userAcls: undefined,
    }),
    true,
  );

  // 1. POST /config: rejects unauthenticated caller
  const unauthRes = (await configRoute.handler(
    { body: { baseUrl: "http://qbit.local:8080" } } as any,
    { params: {}, query: {}, userId: undefined },
  )) as any;
  assert.equal(unauthRes.error, "Authentication required to configure seedbox");

  // 2. POST /config: missing baseUrl
  const missingUrlRes = (await configRoute.handler(
    { body: { username: "admin" } } as any,
    { params: {}, query: {}, userId: "admin-1" },
  )) as any;
  assert.equal(missingUrlRes.error, "baseUrl is required");

  // 3. POST /config: success when authenticated with valid payload
  const successRes = (await configRoute.handler(
    { body: { ...CONFIG } } as any,
    { params: {}, query: {}, userId: "admin-1" },
  )) as any;
  assert.equal(successRes.success, true);

  const storedConfig = await ctx.storage.get<any>("qbit_config");
  assert.ok(storedConfig);
  assert.equal(storedConfig.baseUrl, CONFIG.baseUrl);
  assert.equal(storedConfig.username, CONFIG.username);

  await plugin.teardown();
});

test("GET /torrents reports a typed error when unconfigured", async () => {
  const { plugin, handler } = await makeRouteHarness();
  const res = (await handler({} as any, {
    params: {},
    query: {},
  })) as any;

  assert.equal(res.error, "Seedbox not configured");
  assert.equal(res.code, "not_configured");

  await plugin.teardown();
});

test("GET /torrents returns torrents on success", async () => {
  const { plugin, ctx, handler } = await makeRouteHarness({
    client: fakeClient(),
  });
  await ctx.storage.set("qbit_config", { ...CONFIG });

  const res = (await handler({} as any, {
    params: {},
    query: {},
  })) as any;

  assert.deepEqual(res.torrents, TORRENTS);

  await plugin.teardown();
});

test("GET /torrents returns a typed error instead of rejecting on client failure", async () => {
  const { plugin, ctx, handler } = await makeRouteHarness({
    client: fakeClient({
      loginError: new QBittorrentError("bad credentials", {
        code: "auth_failed",
        status: 403,
      }),
    }),
  });
  await ctx.storage.set("qbit_config", { ...CONFIG });

  const res = (await handler({} as any, {
    params: {},
    query: {},
  })) as any;

  assert.equal(res.code, "auth_failed");
  assert.equal(res.error, "bad credentials");

  await plugin.teardown();
});

test("seedbox:progress rejects unauthenticated senders", async () => {
  const { plugin, sent, invoke } = await makeWsHarness();
  await invoke({ type: "subscribe" }, null);

  assert.equal(sent[0].event, "error");
  assert.equal(sent[0].code, "unauthorized");

  await plugin.teardown();
});

test("seedbox:progress answers ping with pong", async () => {
  const { plugin, sent, invoke } = await makeWsHarness();
  await invoke({ type: "ping" });

  assert.equal(sent[0].event, "pong");
  assert.equal(typeof sent[0].time, "number");

  await plugin.teardown();
});

test("seedbox:progress sends a real torrent snapshot on subscribe and stops on unsubscribe", async () => {
  const { plugin, sent, invoke } = await makeWsHarness({
    client: fakeClient(),
    configured: true,
  });

  await invoke({ type: "subscribe" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, "progress");
  assert.deepEqual(sent[0].torrents, TORRENTS);
  assert.equal(typeof sent[0].time, "number");

  await invoke({ type: "unsubscribe" });
  assert.equal(sent[1].event, "unsubscribed");

  await plugin.teardown();
});

test("seedbox:progress reports not_configured to authenticated subscribers", async () => {
  const { plugin, sent, invoke } = await makeWsHarness();
  await invoke({ type: "subscribe" });

  assert.equal(sent[0].event, "error");
  assert.equal(sent[0].code, "not_configured");

  await plugin.teardown();
});

test("seedbox:progress broadcasts periodic updates to subscribers", async () => {
  const listeners: unknown[] = [];
  const plugin = makePlugin({ client: fakeClient(), progressIntervalMs: 5 });
  const ctx = makeCtx();
  ctx.subscribe(SEEDBOX_PROGRESS_CHANNEL, (event) => {
    listeners.push(event);
  });
  await plugin.init(ctx);
  await ctx.storage.set("qbit_config", { ...CONFIG });

  const progressWs = ctx.wsHandlers.get(SEEDBOX_PROGRESS_CHANNEL);
  assert.ok(progressWs);
  await progressWs({ type: "subscribe" }, { userId: "admin-1", send: () => {} });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(
    listeners.length >= 1,
    `expected at least one broadcast, got ${listeners.length}`,
  );
  assert.equal((listeners[0] as any).event, "progress");

  await plugin.teardown();
});
