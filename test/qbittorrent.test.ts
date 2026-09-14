import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QBittorrentClient,
  QBittorrentError,
  isRetryableQbitError,
  withBackoff,
  type QbitConfig,
} from "../src/qbittorrent.js";

const TORRENTS = [
  {
    hash: "abc123",
    name: "Example Game",
    size: 1_000,
    progress: 0.5,
    dlspeed: 42,
    state: "downloading",
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function loginOk(cookie = "SID=session-token"): Response {
  return new Response("Ok.", {
    status: 200,
    headers: { "set-cookie": `${cookie}; path=/; HttpOnly` },
  });
}

function baseConfig(overrides: Partial<QbitConfig> = {}): QbitConfig {
  return {
    baseUrl: "http://qbit.test:8080/",
    username: "admin",
    password: "hunter2",
    maxRetries: 0,
    timeoutMs: 1_000,
    ...overrides,
  };
}

test("login throws auth_failed when credentials are missing and never calls fetch", async () => {
  let calls = 0;
  const client = new QBittorrentClient(
    baseConfig({
      username: undefined,
      password: undefined,
      fetchFn: (async () => {
        calls += 1;
        return loginOk();
      }) as typeof fetch,
    }),
  );

  await assert.rejects(client.login(), (error: unknown) => {
    assert.ok(error instanceof QBittorrentError);
    assert.equal(error.code, "auth_failed");
    return true;
  });
  assert.equal(calls, 0);
  assert.equal(client.isAuthenticated, false);
});

test("login rejects non-OK HTTP responses with status", async () => {
  const client = new QBittorrentClient(
    baseConfig({
      fetchFn: (async () =>
        new Response("Forbidden", { status: 403 })) as typeof fetch,
    }),
  );

  await assert.rejects(client.login(), (error: unknown) => {
    assert.ok(error instanceof QBittorrentError);
    assert.equal(error.code, "auth_failed");
    assert.equal(error.status, 403);
    return true;
  });
});

test("login rejects a Fails. body even when HTTP is 200", async () => {
  const client = new QBittorrentClient(
    baseConfig({
      fetchFn: (async () => new Response("Fails.", { status: 200 })) as typeof fetch,
    }),
  );

  await assert.rejects(client.login(), (error: unknown) => {
    assert.ok(error instanceof QBittorrentError);
    assert.equal(error.code, "auth_failed");
    return true;
  });
});

test("login stores the SID cookie and getTorrents sends it", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/api/v2/auth/login")) return loginOk();
    return jsonResponse(TORRENTS);
  }) as typeof fetch;

  const client = new QBittorrentClient(baseConfig({ fetchFn }));
  await client.login();
  assert.equal(client.isAuthenticated, true);
  assert.equal(client.hasCredentials, true);

  const torrents = await client.getTorrents();
  assert.deepEqual(torrents, TORRENTS);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "http://qbit.test:8080/api/v2/auth/login");
  assert.equal(requests[0].init?.method, "POST");
  const headers = new Headers(requests[1].init?.headers);
  assert.equal(headers.get("cookie"), "SID=session-token");
  assert.ok(requests[1].init?.signal, "a timeout signal must be attached");
});

test("getTorrents surfaces HTTP failures as http_error", async () => {
  const client = new QBittorrentClient(
    baseConfig({
      fetchFn: (async () =>
        new Response("boom", { status: 500, statusText: "Internal Server Error" })) as typeof fetch,
    }),
  );

  await assert.rejects(client.getTorrents(), (error: unknown) => {
    assert.ok(error instanceof QBittorrentError);
    assert.equal(error.code, "http_error");
    assert.equal(error.status, 500);
    return true;
  });
});

test("getTorrents maps invalid JSON and unexpected payloads to invalid_response", async () => {
  const badJson = new QBittorrentClient(
    baseConfig({
      fetchFn: (async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    }),
  );
  await assert.rejects(badJson.getTorrents(), (error: unknown) => {
    assert.ok(error instanceof QBittorrentError);
    assert.equal(error.code, "invalid_response");
    return true;
  });

  const badShape = new QBittorrentClient(
    baseConfig({
      fetchFn: (async () => jsonResponse({ torrents: [] })) as typeof fetch,
    }),
  );
  await assert.rejects(badShape.getTorrents(), (error: unknown) => {
    assert.ok(error instanceof QBittorrentError);
    assert.equal(error.code, "invalid_response");
    return true;
  });
});

test("getTorrents maps request timeouts to timeout", async () => {
  const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("missing abort signal"));
        return;
      }
      // AbortSignal.timeout() timers are unref'ed; keep the loop alive until abort.
      const keepAlive = setTimeout(() => {}, 1_000);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(keepAlive);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }) as typeof fetch;

  const client = new QBittorrentClient(baseConfig({ fetchFn, timeoutMs: 10 }));
  await assert.rejects(client.getTorrents(), (error: unknown) => {
    assert.ok(error instanceof QBittorrentError);
    assert.equal(error.code, "timeout");
    assert.match(error.message, /timed out after 10ms/);
    return true;
  });
});

test("getTorrents maps transport failures to network_error", async () => {
  const client = new QBittorrentClient(
    baseConfig({
      fetchFn: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    }),
  );

  await assert.rejects(client.getTorrents(), (error: unknown) => {
    assert.ok(error instanceof QBittorrentError);
    assert.equal(error.code, "network_error");
    return true;
  });
});

test("getTorrents re-logs in once on 401/403 and retries with the fresh session", async () => {
  const seen: string[] = [];
  let infoCalls = 0;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const cookie = new Headers(init?.headers).get("cookie");
    seen.push(`${href} cookie=${cookie ?? "none"}`);
    if (href.endsWith("/api/v2/auth/login")) return loginOk("SID=fresh");
    infoCalls += 1;
    if (infoCalls === 1) return new Response("Forbidden", { status: 403 });
    return jsonResponse(TORRENTS);
  }) as typeof fetch;

  const client = new QBittorrentClient(baseConfig({ fetchFn }));
  const torrents = await client.getTorrents();
  assert.deepEqual(torrents, TORRENTS);
  assert.equal(infoCalls, 2);
  assert.equal(seen[1], "http://qbit.test:8080/api/v2/auth/login cookie=none");
  assert.equal(
    seen[2],
    "http://qbit.test:8080/api/v2/torrents/info cookie=SID=fresh",
  );
});

test("withBackoff retries retryable failures with exponential delays", async () => {
  const delays: number[] = [];
  let calls = 0;
  const result = await withBackoff(
    async () => {
      calls += 1;
      if (calls < 3) {
        throw new QBittorrentError("timed out", { code: "timeout" });
      }
      return "ok";
    },
    {
      maxRetries: 2,
      baseDelayMs: 10,
      sleep: async (ms) => {
        delays.push(ms);
      },
    },
  );

  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("withBackoff does not retry non-retryable errors", async () => {
  let calls = 0;
  await assert.rejects(
    withBackoff(
      async () => {
        calls += 1;
        throw new QBittorrentError("bad request", {
          code: "http_error",
          status: 400,
        });
      },
      { maxRetries: 3, sleep: async () => {} },
    ),
    (error: unknown) => {
      assert.ok(error instanceof QBittorrentError);
      assert.equal(error.status, 400);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("withBackoff rethrows the last error after exhausting retries", async () => {
  let calls = 0;
  await assert.rejects(
    withBackoff(
      async () => {
        calls += 1;
        throw new QBittorrentError("network down", { code: "network_error" });
      },
      { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} },
    ),
    (error: unknown) => {
      assert.ok(error instanceof QBittorrentError);
      assert.equal(error.code, "network_error");
      return true;
    },
  );
  assert.equal(calls, 3);
});

test("isRetryableQbitError classifies transient and server failures", () => {
  assert.equal(
    isRetryableQbitError(new QBittorrentError("t", { code: "timeout" })),
    true,
  );
  assert.equal(
    isRetryableQbitError(new QBittorrentError("n", { code: "network_error" })),
    true,
  );
  assert.equal(
    isRetryableQbitError(
      new QBittorrentError("s", { code: "http_error", status: 503 }),
    ),
    true,
  );
  assert.equal(
    isRetryableQbitError(
      new QBittorrentError("c", { code: "http_error", status: 401 }),
    ),
    false,
  );
  assert.equal(
    isRetryableQbitError(new QBittorrentError("a", { code: "auth_failed" })),
    false,
  );
  assert.equal(isRetryableQbitError(new Error("plain")), false);
});

test("checkHealth reports a healthy authenticated session", async () => {
  const client = new QBittorrentClient(
    baseConfig({
      fetchFn: (async () =>
        new Response("v5.0.0", { status: 200 })) as typeof fetch,
    }),
  );

  const health = await client.checkHealth();
  assert.equal(health.reachable, true);
  assert.equal(health.authenticated, true);
  assert.equal(typeof health.checkedAt, "number");
  assert.equal(typeof health.latencyMs, "number");
});

test("checkHealth re-authenticates on 403 when credentials exist", async () => {
  let calls = 0;
  const fetchFn = (async (url: string | URL) => {
    calls += 1;
    if (String(url).endsWith("/api/v2/app/version")) {
      return new Response("Forbidden", { status: 403 });
    }
    return loginOk();
  }) as typeof fetch;

  const client = new QBittorrentClient(baseConfig({ fetchFn }));
  const health = await client.checkHealth();
  assert.equal(health.reachable, true);
  assert.equal(health.authenticated, true);
  assert.equal(calls, 2);
});

test("checkHealth reports unreachable on timeout without throwing", async () => {
  const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const keepAlive = setTimeout(() => {}, 1_000);
      init?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(keepAlive);
          reject(init.signal?.reason);
        },
        { once: true },
      );
    });
  }) as typeof fetch;

  const client = new QBittorrentClient(baseConfig({ fetchFn, timeoutMs: 10 }));
  const health = await client.checkHealth();
  assert.equal(health.reachable, false);
  assert.equal(health.authenticated, false);
  assert.match(health.error ?? "", /timed out/);
});
