import { test } from "node:test";
import assert from "node:assert/strict";
import { MockPluginContext } from "@droposs/plugin-sdk";
import SeedboxPlugin from "../src/index.js";

test("SeedboxPlugin registers routes, enforces auth on config, and handles progress WS", async () => {
  const plugin = new SeedboxPlugin();
  const ctx = new MockPluginContext("drop-seedbox", [
    "routes",
    "storage",
    "network",
    "websocket",
  ]);

  await plugin.init(ctx);

  const configRoute = ctx.routes.get("POST /config");
  assert.ok(configRoute, "POST /config must be registered");

  const torrentsRoute = ctx.routes.get("GET /torrents");
  assert.ok(torrentsRoute, "GET /torrents must be registered");

  const progressWs = ctx.wsHandlers.get("seedbox:progress");
  assert.ok(
    progressWs,
    "seedbox:progress websocket handler must be registered",
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
    {
      body: {
        baseUrl: "http://qbit.local:8080",
        username: "admin",
        password: "password123",
      },
    } as any,
    { params: {}, query: {}, userId: "admin-1" },
  )) as any;
  assert.equal(successRes.success, true);

  // Check stored config
  const storedConfig = await ctx.storage.get<any>("qbit_config");
  assert.ok(storedConfig);
  assert.equal(storedConfig.baseUrl, "http://qbit.local:8080");
  assert.equal(storedConfig.username, "admin");

  // 4. WebSocket progress channel
  let wsSent: any = null;
  await progressWs(
    {},
    {
      userId: "admin-1",
      send: (data) => {
        wsSent = data;
      },
    },
  );
  assert.equal(wsSent?.event, "pong");
  assert.ok(typeof wsSent?.time === "number");
});

test("SeedboxPlugin GET /torrents reports error when unconfigured", async () => {
  const plugin = new SeedboxPlugin();
  const ctx = new MockPluginContext("drop-seedbox", [
    "routes",
    "storage",
    "network",
    "websocket",
  ]);

  await plugin.init(ctx);

  const torrentsRoute = ctx.routes.get("GET /torrents");
  assert.ok(torrentsRoute, "GET /torrents must be registered");
  const res = (await torrentsRoute.handler({} as any, {
    params: {},
    query: {},
  })) as any;

  assert.equal(res.error, "Seedbox not configured");
});
