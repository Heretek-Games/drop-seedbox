import { test } from "node:test";
import assert from "node:assert/strict";
import { MockPluginContext } from "@droposs/plugin-sdk";
import SeedboxPlugin, {
  SEEDBOX_ALLOW_LOOPBACK_ENV,
  SEEDBOX_DEPOTS_KEY,
  SEEDBOX_MAPPING_GAME_PREFIX,
  SEEDBOX_PROGRESS_CHANNEL,
  SEEDBOX_STREAM_AUTH_KEY,
  type SeedboxClient,
} from "../src/index.js";
import { QBittorrentError, type QbitTorrent } from "../src/qbittorrent.js";
import { decryptSecret, encryptSecret, loadConfigKey } from "../src/secrets.js";

process.env.DROP_SEEDBOX_CONFIG_KEY =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

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
    "storage:depot",
  ]);
}

function fakeClient(
  options: {
    torrents?: QbitTorrent[];
    loginError?: Error;
    torrentsError?: Error;
  } = {},
): SeedboxClient {
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
  assert.ok(
    progressWs,
    "seedbox:progress websocket handler must be registered",
  );
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

  assert.equal(
    ctx.authorizers.length,
    1,
    "a subscription authorizer is registered",
  );
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

  // 2b. POST /config: rejects non-http(s) and credential-bearing base URLs
  const badScheme = (await configRoute.handler(
    { body: { baseUrl: "ftp://qbit.local" } } as any,
    { params: {}, query: {}, userId: "admin-1" },
  )) as any;
  assert.equal(badScheme.code, "invalid_config");

  const embeddedCreds = (await configRoute.handler(
    { body: { baseUrl: "http://user:pass@qbit.local:8080" } } as any,
    { params: {}, query: {}, userId: "admin-1" },
  )) as any;
  assert.equal(embeddedCreds.code, "invalid_config");

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
  // The password is never persisted in plaintext.
  assert.equal(storedConfig.credentialsEncrypted, true);
  assert.notEqual(storedConfig.password, CONFIG.password);
  assert.match(storedConfig.password, /^v1:/);

  await plugin.teardown();
});

test("POST /config refuses to persist a plaintext password without a key", async () => {
  const saved = process.env.DROP_SEEDBOX_CONFIG_KEY;
  delete process.env.DROP_SEEDBOX_CONFIG_KEY;
  try {
    const plugin = makePlugin();
    const ctx = makeCtx();
    await plugin.init(ctx);
    const configRoute = ctx.routes.get("POST /config");
    assert.ok(configRoute);

    const res = (await configRoute.handler({ body: { ...CONFIG } } as any, {
      params: {},
      query: {},
      userId: "admin-1",
    })) as any;
    assert.equal(res.code, "invalid_config");
    assert.match(res.error, /DROP_SEEDBOX_CONFIG_KEY/);
    assert.equal(await ctx.storage.get("qbit_config"), null);

    await plugin.teardown();
  } finally {
    process.env.DROP_SEEDBOX_CONFIG_KEY = saved;
  }
});

test("REST routes reject unauthenticated callers", async () => {
  const plugin = makePlugin({ client: fakeClient() });
  const ctx = makeCtx();
  await plugin.init(ctx);
  await ctx.storage.set("qbit_config", { ...CONFIG });

  const checks: Array<[string, Record<string, string>]> = [
    ["POST /config", {}],
    ["GET /torrents", {}],
    ["POST /torrents", {}],
    ["POST /torrents/:hash/pause", { hash: "h1" }],
    ["POST /torrents/:hash/resume", { hash: "h1" }],
    ["DELETE /torrents/:hash", { hash: "h1" }],
    ["GET /transfer", {}],
    ["GET /health", {}],
    ["GET /depots", {}],
    ["POST /depots", {}],
    ["DELETE /depots/:id", { id: "d1" }],
    ["POST /mappings", {}],
    ["GET /mappings", { hash: "h1" }],
    ["GET /mappings/:gameId", { gameId: "g1" }],
  ];
  for (const [name, params] of checks) {
    const route = ctx.routes.get(name);
    assert.ok(route, `${name} must be registered`);
    const res = (await route.handler({} as any, {
      params,
      query: {},
      userId: undefined,
    })) as any;
    assert.equal(res.code, "unauthorized", `${name} must require auth`);
  }

  await plugin.teardown();
});

test("GET /torrents reports a typed error when unconfigured", async () => {
  const { plugin, handler } = await makeRouteHarness();
  const res = (await handler({} as any, {
    params: {},
    query: {},
    userId: "u1",
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
    userId: "u1",
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
    userId: "u1",
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
  await progressWs(
    { type: "subscribe" },
    { userId: "admin-1", send: () => {} },
  );

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
  const calls: RecordedCalls = {
    added: [],
    paused: [],
    resumed: [],
    deleted: [],
  };
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
  await pause.handler({} as any, {
    params: { hash: "abc" },
    query: {},
    userId: "u1",
  });
  assert.deepEqual(calls.paused, [["abc"]]);

  const resume = ctx.routes.get("POST /torrents/:hash/resume");
  assert.ok(resume);
  await resume.handler({} as any, {
    params: { hash: "abc" },
    query: {},
    userId: "u1",
  });
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
    userId: "u1",
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

  const unauth = (await create.handler(
    { body: { gameId: "g1", hash: "h1" } } as any,
    {
      params: {},
      query: {},
      userId: undefined,
    },
  )) as any;
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
    .handler({} as any, {
      params: { gameId: "g1" },
      query: {},
      userId: "u1",
    })) as any;
  assert.equal(byGame.mapping.hash, "h1");

  const byHash = (await ctx.routes.get("GET /mappings")!.handler({} as any, {
    params: {},
    query: { hash: "h1" },
    userId: "u1",
  })) as any;
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
    userId: "u1",
  })) as any;
  assert.equal(unconfigured.code, "not_configured");

  await ctx.storage.set("qbit_config", { ...CONFIG });
  const probe = (await health.handler({} as any, {
    params: {},
    query: {},
    userId: "u1",
  })) as any;
  assert.equal(probe.health.reachable, true);
  assert.equal(probe.health.authenticated, true);

  await plugin.teardown();
});

test("GET /health returns a typed unreachable result for a legacy invalid baseUrl", async () => {
  const plugin = makePlugin({ client: fakeClient() });
  const ctx = makeCtx();
  await plugin.init(ctx);

  const health = ctx.routes.get("GET /health");
  assert.ok(health);

  const cases: Array<[string, RegExp]> = [
    ["qbit.local:8080", /http or https scheme/],
    ["://bad", /absolute http\(s\) URL/],
    ["http://127.0.0.1:8080", /loopback/],
    ["http://169.254.169.254", /link-local/],
  ];
  for (const [baseUrl, expected] of cases) {
    await ctx.storage.set("qbit_config", {
      baseUrl,
      username: "admin",
      password: "password123",
    });
    const res = (await health.handler({} as any, {
      params: {},
      query: {},
      userId: "u1",
    })) as any;

    assert.equal(
      res.health?.reachable,
      false,
      `${baseUrl} must be unreachable`,
    );
    assert.equal(res.health?.authenticated, false, baseUrl);
    assert.equal(typeof res.health?.error, "string", baseUrl);
    assert.match(res.health.error, expected, baseUrl);
  }

  await plugin.teardown();
});

test("GET /health does not throw when client creation fails", async () => {
  const plugin = new SeedboxPlugin({
    clientFactory: () => {
      throw new QBittorrentError("invalid legacy baseUrl", {
        code: "invalid_config",
      });
    },
  });
  const ctx = makeCtx();
  await plugin.init(ctx);
  await ctx.storage.set("qbit_config", {
    baseUrl: "http://192.168.1.50:8080",
    username: "admin",
    password: "password123",
  });

  const health = ctx.routes.get("GET /health");
  assert.ok(health);
  const res = (await health.handler({} as any, {
    params: {},
    query: {},
    userId: "u1",
  })) as any;

  assert.equal(res.health.reachable, false);
  assert.equal(res.health.authenticated, false);
  assert.match(res.health.error, /invalid legacy baseUrl/);

  await plugin.teardown();
});

async function seedLegacyCredentials(): Promise<{
  plugin: SeedboxPlugin;
  ctx: MockPluginContext;
}> {
  const plugin = makePlugin({ client: fakeClient() });
  const ctx = makeCtx();
  await plugin.init(ctx);
  await ctx.storage.set("qbit_config", {
    baseUrl: "http://192.168.1.50:8080",
    username: "admin",
    password: "legacy-password",
  });
  return { plugin, ctx };
}

async function requestTorrents(ctx: MockPluginContext): Promise<any> {
  const route = ctx.routes.get("GET /torrents");
  assert.ok(route);
  const res = (await route.handler({} as any, {
    params: {},
    query: {},
    userId: "u1",
  })) as any;
  assert.deepEqual(res.torrents, TORRENTS);
  return res;
}

test("legacy plaintext credentials are re-sealed in storage on read", async () => {
  const { plugin, ctx } = await seedLegacyCredentials();
  await requestTorrents(ctx);

  const stored = await ctx.storage.get<any>("qbit_config");
  assert.ok(stored);
  assert.equal(stored.credentialsEncrypted, true);
  assert.notEqual(stored.password, "legacy-password");
  assert.match(stored.password, /^v1:/);

  const key = loadConfigKey();
  assert.ok(key, "the test encryption key must be configured");
  assert.equal(decryptSecret(stored.password, key), "legacy-password");

  await plugin.teardown();
});

test("decryptSecret rejects tampered ciphertext, auth tag, or malformed payloads", () => {
  const key = loadConfigKey();
  assert.ok(key, "the test encryption key must be configured");
  const secret = "super-secret-password";
  const encrypted = encryptSecret(secret, key);

  // Success baseline
  assert.equal(decryptSecret(encrypted, key), secret);

  const parts = encrypted.split(":");
  assert.equal(parts.length, 4);
  const [version, ivB64, tagB64, ciphertextB64] = parts;

  // Tamper ciphertext
  const rawCiphertext = Buffer.from(ciphertextB64, "base64");
  rawCiphertext[0] ^= 0x01;
  const tamperedCiphertext = [
    version,
    ivB64,
    tagB64,
    rawCiphertext.toString("base64"),
  ].join(":");
  assert.throws(() => decryptSecret(tamperedCiphertext, key));

  // Tamper auth tag
  const rawTag = Buffer.from(tagB64, "base64");
  rawTag[0] ^= 0x01;
  const tamperedTag = [
    version,
    ivB64,
    rawTag.toString("base64"),
    ciphertextB64,
  ].join(":");
  assert.throws(() => decryptSecret(tamperedTag, key));

  // Malformed payloads
  assert.throws(
    () => decryptSecret("invalid-payload", key),
    /Malformed encrypted seedbox secret/,
  );
  assert.throws(
    () => decryptSecret(`v2:${ivB64}:${tagB64}:${ciphertextB64}`, key),
    /Malformed encrypted seedbox secret/,
  );
});

test("legacy plaintext credentials still resolve when no key is configured", async () => {
  const saved = process.env.DROP_SEEDBOX_CONFIG_KEY;
  delete process.env.DROP_SEEDBOX_CONFIG_KEY;
  try {
    const { plugin, ctx } = await seedLegacyCredentials();
    await requestTorrents(ctx);

    // Without a key the legacy row is left untouched (reads never write
    // plaintext, and there is nothing to encrypt with).
    const stored = await ctx.storage.get<any>("qbit_config");
    assert.equal(stored.password, "legacy-password");
    assert.notEqual(stored.credentialsEncrypted, true);

    await plugin.teardown();
  } finally {
    process.env.DROP_SEEDBOX_CONFIG_KEY = saved;
  }
});

test("POST /config enforces the SSRF host policy with a loopback opt-in", async () => {
  const saved = process.env[SEEDBOX_ALLOW_LOOPBACK_ENV];
  delete process.env[SEEDBOX_ALLOW_LOOPBACK_ENV];
  try {
    const plugin = makePlugin();
    const ctx = makeCtx();
    await plugin.init(ctx);
    const config = ctx.routes.get("POST /config");
    assert.ok(config);
    const routeCtx = { params: {}, query: {}, userId: "u1" };
    const bodyFor = (baseUrl: string) => ({
      baseUrl,
      username: "admin",
      password: "password123",
    });

    const loopback = (await config.handler(
      { body: bodyFor("http://127.0.0.1:8080") } as any,
      routeCtx,
    )) as any;
    assert.equal(loopback.code, "invalid_config");
    assert.match(loopback.error, /loopback/);

    const linkLocal = (await config.handler(
      { body: bodyFor("http://169.254.169.254") } as any,
      routeCtx,
    )) as any;
    assert.equal(linkLocal.code, "invalid_config");
    assert.match(linkLocal.error, /link-local/);

    const lan = (await config.handler(
      { body: bodyFor("http://192.168.1.50:8080") } as any,
      routeCtx,
    )) as any;
    assert.equal(lan.success, true);

    process.env[SEEDBOX_ALLOW_LOOPBACK_ENV] = "true";
    const optIn = (await config.handler(
      { body: bodyFor("http://localhost:8080") } as any,
      routeCtx,
    )) as any;
    assert.equal(optIn.success, true);

    await plugin.teardown();
  } finally {
    if (saved === undefined) {
      delete process.env[SEEDBOX_ALLOW_LOOPBACK_ENV];
    } else {
      process.env[SEEDBOX_ALLOW_LOOPBACK_ENV] = saved;
    }
  }
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

  await create.handler(
    { body: { id: "b", endpoint: "http://b", priority: 200 } } as any,
    {
      params: {},
      query: {},
      userId: "u1",
    },
  );
  await create.handler(
    { body: { id: "a", endpoint: "http://a", priority: 10 } } as any,
    {
      params: {},
      query: {},
      userId: "u1",
    },
  );

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

test("DepotStorageProvider resolves mapped seedbox content as an HTTP stream", async () => {
  const plugin = makePlugin();
  const ctx = makeCtx();
  await plugin.init(ctx);

  const provider = ctx.depotProviders.get("drop-seedbox");
  assert.ok(provider, "drop-seedbox must register a depot provider");

  // No depot configured yet.
  assert.equal(await provider.resolveDepotStream("", "game-1"), null);

  await ctx.storage.set(SEEDBOX_DEPOTS_KEY, [
    {
      id: "primary",
      endpoint: "https://seed.example/depot/",
      enabled: true,
      priority: 10,
      updatedAt: 0,
    },
  ]);

  // Depot registered but the game has no mapping.
  assert.equal(await provider.resolveDepotStream("", "game-1"), null);

  await ctx.storage.set(`${SEEDBOX_MAPPING_GAME_PREFIX}game-1`, {
    gameId: "game-1",
    contentPath: "My Game/Game.exe",
    updatedAt: 0,
  });
  const stream = await provider.resolveDepotStream("", "game-1");
  assert.equal(
    stream?.url,
    "https://seed.example/depot/My%20Game%2FGame.exe",
  );

  await ctx.storage.set(SEEDBOX_STREAM_AUTH_KEY, "Bearer t");
  const authed = await provider.resolveDepotStream("primary", "game-1");
  assert.deepEqual(authed?.headers, { Authorization: "Bearer t" });
});

test("DepotStorageProvider selects the lowest-priority enabled depot", async () => {
  const plugin = makePlugin();
  const ctx = makeCtx();
  await plugin.init(ctx);
  const provider = ctx.depotProviders.get("drop-seedbox");
  assert.ok(provider);

  await ctx.storage.set(SEEDBOX_DEPOTS_KEY, [
    {
      id: "slow",
      endpoint: "https://slow.example",
      enabled: true,
      priority: 100,
      updatedAt: 0,
    },
    {
      id: "fast",
      endpoint: "https://fast.example",
      enabled: true,
      priority: 1,
      updatedAt: 0,
    },
    {
      id: "off",
      endpoint: "https://off.example",
      enabled: false,
      priority: 0,
      updatedAt: 0,
    },
  ]);
  await ctx.storage.set(`${SEEDBOX_MAPPING_GAME_PREFIX}game-1`, {
    gameId: "game-1",
    hash: "abc123",
    updatedAt: 0,
  });

  const stream = await provider.resolveDepotStream("", "game-1");
  assert.equal(stream?.url, "https://fast.example/abc123");

  const explicit = await provider.resolveDepotStream("slow", "game-1");
  assert.equal(explicit?.url, "https://slow.example/abc123");

  const disabled = await provider.resolveDepotStream("off", "game-1");
  assert.equal(disabled, null);
});

