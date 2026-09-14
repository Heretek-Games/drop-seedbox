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
    async checkHealth() {
      return {
        reachable: true,
        authenticated: true,
        checkedAt: Date.now(),
        latencyMs: 5,
      };
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

interface RecordedCalls {
  added: any[];
  paused: string[][];
  resumed: string[][];
  deleted: Array<{ hashes: string[]; deleteFiles?: boolean }>;
}

function recordingClient(calls: RecordedCalls): SeedboxClient {
  return {
    async login(): Promise<void> {},
    async getTorrents(): Promise<QbitTorrent[]> {
      return TORRENTS;
    },
    async addTorrent(options): Promise<void> {
      calls.added.push(options);
    },
    async pauseTorrents(hashes): Promise<void> {
      calls.paused.push(hashes);
    },
    async resumeTorrents(hashes): Promise<void> {
      calls.resumed.push(hashes);
    },
    async deleteTorrents(hashes, deleteFiles): Promise<void> {
      calls.deleted.push({ hashes, deleteFiles });
    },
    async getTransferInfo() {
      return {
        dl_info_speed: 1,
        up_info_speed: 2,
        dl_info_data: 3,
        up_info_data: 4,
        connection_status: "connected",
      };
    },
    async checkHealth() {
      return {
        reachable: true,
        authenticated: true,
        checkedAt: Date.now(),
        latencyMs: 5,
      };
    },
  };
}

test("torrent management routes require auth and call the client", async () => {
  const calls: RecordedCalls = { added: [], paused: [], resumed: [], deleted: [] };
  const plugin = makePlugin({ client: recordingClient(calls) });
  const ctx = makeCtx();
  await plugin.init(ctx);
  await ctx.storage.set("qbit_config", { ...CONFIG });

  const add = ctx.routes.get("POST /torrents");
  assert.ok(add, "POST /torrents must be registered");

  const unauth = (await add.handler({ body: { url: "magnet:x" } } as any, {
    params: {},
    query: {},
    userId: undefined,
  })) as any;
  assert.equal(unauth.error, "Authentication required to add torrents");

  const missing = (await add.handler({ body: {} } as any, {
    params: {},
    query: {},
    userId: "u1",
  })) as any;
  assert.equal(missing.error, "url or torrentFile is required");

  const ok = (await add.handler(
    { body: { url: "magnet:x", savePath: "/data" } } as any,
    { params: {}, query: {}, userId: "u1" },
  )) as any;
  assert.equal(ok.success, true);
  assert.equal(calls.added.length, 1);
  assert.equal(calls.added[0].url, "magnet:x");

  const base64 = Buffer.from("torrent-bytes").toString("base64");
  await add.handler(
    { body: { torrentFile: base64, torrentFileName: "game.torrent" } } as any,
    { params: {}, query: {}, userId: "u1" },
  );
  assert.ok(calls.added[1].torrentFile instanceof Uint8Array);

  const pause = ctx.routes.get("POST /torrents/:hash/pause");
  assert.ok(pause);
  await pause.handler({} as any, { params: { hash: "abc" }, query: {}, userId: "u1" });
  assert.deepEqual(calls.paused, [["abc"]]);

  const resume = ctx.routes.get("POST /torrents/:hash/resume");
  assert.ok(resume);
  await resume.handler({} as any, { params: { hash: "abc" }, query: {}, userId: "u1" });
  assert.deepEqual(calls.resumed, [["abc"]]);

  const del = ctx.routes.get("DELETE /torrents/:hash");
  assert.ok(del);
  await del.handler({ body: { deleteFiles: true } } as any, {
    params: { hash: "abc" },
    query: {},
    userId: "u1",
  });
  assert.deepEqual(calls.deleted, [{ hashes: ["abc"], deleteFiles: true }]);

  const transfer = ctx.routes.get("GET /transfer");
  assert.ok(transfer);
  const transferRes = (await transfer.handler({} as any, {
    params: {},
    query: {},
  })) as any;
  assert.equal(transferRes.transfer.dl_info_speed, 1);

  await plugin.teardown();
});

test("mapping routes associate torrents and games", async () => {
  const plugin = makePlugin({ client: fakeClient() });
  const ctx = makeCtx();
  await plugin.init(ctx);

  const create = ctx.routes.get("POST /mappings");
  assert.ok(create, "POST /mappings must be registered");

  const unauth = (await create.handler({ body: { gameId: "g1", hash: "h1" } } as any, {
    params: {},
    query: {},
    userId: undefined,
  })) as any;
  assert.equal(unauth.error, "Authentication required to configure mappings");

  const missing = (await create.handler({ body: { gameId: "g1" } } as any, {
    params: {},
    query: {},
    userId: "u1",
  })) as any;
  assert.equal(missing.error, "hash or contentPath is required");

  const ok = (await create.handler(
    { body: { gameId: "g1", hash: "h1", contentPath: "/data/g1" } } as any,
    { params: {}, query: {}, userId: "u1" },
  )) as any;
  assert.equal(ok.success, true);

  const byGame = (await ctx.routes
    .get("GET /mappings/:gameId")!
    .handler({} as any, { params: { gameId: "g1" }, query: {} })) as any;
  assert.equal(byGame.mapping.hash, "h1");

  const byHash = (await ctx.routes
    .get("GET /mappings")!
    .handler({} as any, { params: {}, query: { hash: "h1" } })) as any;
  assert.equal(byHash.mapping.gameId, "g1");

  await plugin.teardown();
});

test("health reports not_configured then a probe result", async () => {
  const plugin = makePlugin({ client: fakeClient() });
  const ctx = makeCtx();
  await plugin.init(ctx);

  const health = ctx.routes.get("GET /health");
  assert.ok(health);
  const unconfigured = (await health.handler({} as any, {
    params: {},
    query: {},
  })) as any;
  assert.equal(unconfigured.code, "not_configured");

  await ctx.storage.set("qbit_config", { ...CONFIG });
  const probe = (await health.handler({} as any, {
    params: {},
    query: {},
  })) as any;
  assert.equal(probe.health.reachable, true);
  assert.equal(probe.health.authenticated, true);

  await plugin.teardown();
});

test("depot registry requires auth and orders by priority", async () => {
  const plugin = makePlugin({ client: fakeClient() });
  const ctx = makeCtx();
  await plugin.init(ctx);

  const list = ctx.routes.get("GET /depots");
  const create = ctx.routes.get("POST /depots");
  const remove = ctx.routes.get("DELETE /depots/:id");
  assert.ok(list && create && remove);

  const unauth = (await list.handler({} as any, {
    params: {},
    query: {},
    userId: undefined,
  })) as any;
  assert.equal(unauth.error, "Authentication required to view depots");

  const missing = (await create.handler({ body: {} } as any, {
    params: {},
    query: {},
    userId: "u1",
  })) as any;
  assert.equal(missing.error, "id and endpoint are required");

  await create.handler({ body: { id: "b", endpoint: "http://b", priority: 200 } } as any, {
    params: {},
    query: {},
    userId: "u1",
  });
  await create.handler({ body: { id: "a", endpoint: "http://a", priority: 10 } } as any, {
    params: {},
    query: {},
    userId: "u1",
  });

  const listed = (await list.handler({} as any, {
    params: {},
    query: {},
    userId: "u1",
  })) as any;
  assert.deepEqual(
    listed.depots.map((depot: { id: string }) => depot.id),
    ["a", "b"],
  );

  const removed = (await remove.handler({} as any, {
    params: { id: "a" },
    query: {},
    userId: "u1",
  })) as any;
  assert.equal(removed.removed, 1);

  await plugin.teardown();
});
