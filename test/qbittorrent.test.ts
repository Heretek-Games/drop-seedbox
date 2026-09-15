import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QBittorrentClient,
  QBittorrentError,
  SEEDBOX_ALLOW_LOOPBACK_ENV,
  isRetryableQbitError,
  parseQbitBaseUrl,
  validateQbitHost,
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

function recordingFetch(respond: (url: string) => Response): {
  fetchFn: typeof fetch;
  requests: Array<{ url: string; init?: RequestInit }>;
} {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/api/v2/auth/login")) return loginOk();
    return respond(String(url));
  }) as typeof fetch;
  return { fetchFn, requests };
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
      fetchFn: (async () =>
        new Response("Fails.", { status: 200 })) as typeof fetch,
    }),
  );

  await assert.rejects(client.login(), (error: unknown) => {
    assert.ok(error instanceof QBittorrentError);
    assert.equal(error.code, "auth_failed");
    return true;
  });
});

test("login stores the SID cookie and getTorrents sends it", async () => {
  const { fetchFn, requests } = recordingFetch(() => jsonResponse(TORRENTS));

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
        new Response("boom", {
          status: 500,
          statusText: "Internal Server Error",
        })) as typeof fetch,
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

test("addTorrent posts a magnet URL and re-logs in once on 403", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let addCalls = 0;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/api/v2/auth/login")) return loginOk();
    addCalls += 1;
    if (addCalls === 1) return new Response("Forbidden", { status: 403 });
    return new Response("Ok.", { status: 200 });
  }) as typeof fetch;

  const client = new QBittorrentClient(baseConfig({ fetchFn }));
  await client.login();
  await client.addTorrent({
    url: "magnet:?xt=urn:btih:abc",
    savePath: "/data/games",
    category: "games",
    paused: true,
  });

  assert.equal(addCalls, 2);
  const add = requests.find(
    (r) => r.url.endsWith("/api/v2/torrents/add") && r.init?.method === "POST",
  );
  assert.ok(add, "a torrents/add request must be sent");
  const body = add.init?.body as URLSearchParams;
  assert.equal(body.get("urls"), "magnet:?xt=urn:btih:abc");
  assert.equal(body.get("savepath"), "/data/games");
  assert.equal(body.get("category"), "games");
  assert.equal(body.get("paused"), "true");
});

test("addTorrent uploads a .torrent file as multipart", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/api/v2/auth/login")) return loginOk();
    return new Response("Ok.", { status: 200 });
  }) as typeof fetch;

  const client = new QBittorrentClient(baseConfig({ fetchFn }));
  await client.login();
  await client.addTorrent({
    torrentFile: new Uint8Array([1, 2, 3]),
    torrentFileName: "game.torrent",
    savePath: "/srv/games",
  });

  const add = requests.find((r) => r.url.endsWith("/api/v2/torrents/add"));
  assert.ok(
    add?.init?.body instanceof FormData,
    "body must be multipart form data",
  );
  const form = add.init?.body as FormData;
  assert.equal(form.get("savepath"), "/srv/games");
  assert.ok(form.get("torrents") instanceof Blob);
});

test("addTorrent rejects an empty request", async () => {
  const client = new QBittorrentClient(
    baseConfig({ fetchFn: (async () => loginOk()) as typeof fetch }),
  );
  await assert.rejects(client.addTorrent({}), (error: unknown) => {
    assert.ok(error instanceof QBittorrentError);
    assert.equal(error.code, "invalid_response");
    return true;
  });
});

test("pause/resume/delete and transfer use the documented endpoints", async () => {
  const { fetchFn, requests } = recordingFetch((url) => {
    if (url.endsWith("/api/v2/transfer/info")) {
      return jsonResponse({
        dl_info_speed: 1,
        up_info_speed: 2,
        dl_info_data: 3,
        up_info_data: 4,
        connection_status: "connected",
      });
    }
    return new Response("Ok.", { status: 200 });
  });

  const client = new QBittorrentClient(baseConfig({ fetchFn }));
  await client.login();
  await client.pauseTorrents(["a", "b"]);
  await client.resumeTorrents(["a"]);
  await client.deleteTorrents(["a", "b"], true);
  const transfer = await client.getTransferInfo();

  assert.equal(transfer.dl_info_speed, 1);
  const pause = requests.find((r) => r.url.endsWith("/api/v2/torrents/pause"));
  assert.equal((pause?.init?.body as URLSearchParams).get("hashes"), "a|b");
  const del = requests.find((r) => r.url.endsWith("/api/v2/torrents/delete"));
  assert.equal((del?.init?.body as URLSearchParams).get("deleteFiles"), "true");
});

test("requests carry Origin and Referer matching the base URL", async () => {
  const { fetchFn, requests } = recordingFetch(() => jsonResponse(TORRENTS));

  const client = new QBittorrentClient(baseConfig({ fetchFn }));
  await client.login();
  await client.getTorrents();

  for (const request of requests) {
    const headers = new Headers(request.init?.headers);
    assert.equal(headers.get("origin"), "http://qbit.test:8080");
    assert.equal(headers.get("referer"), "http://qbit.test:8080/");
  }
});

test("constructor rejects invalid base URLs with invalid_config", () => {
  for (const baseUrl of [
    "ftp://qbit.test",
    "not-a-url",
    "http://user:pass@qbit.test:8080",
    "",
  ]) {
    assert.throws(
      () => new QBittorrentClient(baseConfig({ baseUrl })),
      (error: unknown) => {
        assert.ok(error instanceof QBittorrentError);
        assert.equal(error.code, "invalid_config");
        return true;
      },
      `expected ${JSON.stringify(baseUrl)} to be rejected`,
    );
  }
});

test("parseQbitBaseUrl normalizes valid URLs and rejects unsafe ones", () => {
  assert.deepEqual(parseQbitBaseUrl("http://qbit.test:8080/"), {
    ok: true,
    url: "http://qbit.test:8080",
    origin: "http://qbit.test:8080",
  });
  assert.equal(parseQbitBaseUrl("https://seed.example.org").ok, true);
  assert.equal(parseQbitBaseUrl("javascript:alert(1)").ok, false);
  assert.equal(parseQbitBaseUrl("http://u:p@qbit.test").ok, false);
  assert.equal(parseQbitBaseUrl(123).ok, false);
});

test("validateQbitHost rejects loopback hosts by default and allows the opt-in", () => {
  for (const host of [
    "127.0.0.1",
    "127.9.250.1",
    "localhost",
    "qbit.localhost",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
  ]) {
    const result = validateQbitHost(host);
    assert.equal(result.ok, false, `${host} must be rejected by default`);
    assert.match(
      result.ok ? "" : result.error,
      /loopback/,
      `${host} must report a loopback rejection`,
    );
  }

  assert.equal(validateQbitHost("127.0.0.1", { allowLoopback: true }).ok, true);
  assert.equal(validateQbitHost("localhost", { allowLoopback: true }).ok, true);
  assert.equal(validateQbitHost("[::1]", { allowLoopback: true }).ok, true);
});

test("validateQbitHost rejects link-local metadata hosts regardless of the loopback opt-in", () => {
  for (const host of [
    "169.254.169.254",
    "169.254.0.1",
    "fe80::1",
    "fe80::abcd",
    "::ffff:169.254.169.254",
  ]) {
    for (const allowLoopback of [false, true]) {
      const result = validateQbitHost(host, { allowLoopback });
      assert.equal(
        result.ok,
        false,
        `${host} must be rejected (allowLoopback=${allowLoopback})`,
      );
      assert.match(
        result.ok ? "" : result.error,
        /link-local/,
        `${host} must report a link-local rejection`,
      );
    }
  }
});

test("validateQbitHost keeps RFC1918 and ULA hosts allowed by default", () => {
  for (const host of [
    "10.0.0.5",
    "172.16.1.1",
    "172.31.255.254",
    "192.168.1.50",
    "fd00::1",
    "fd12:3456:789a::1",
    "seedbox.example.com",
    "qbit.local",
  ]) {
    assert.equal(validateQbitHost(host).ok, true, `${host} must be allowed`);
  }
});

test("parseQbitBaseUrl applies the host policy with the SEEDBOX_ALLOW_LOOPBACK opt-in", () => {
  const saved = process.env[SEEDBOX_ALLOW_LOOPBACK_ENV];
  try {
    delete process.env[SEEDBOX_ALLOW_LOOPBACK_ENV];
    assert.equal(parseQbitBaseUrl("http://127.0.0.1:8080").ok, false);
    assert.equal(parseQbitBaseUrl("http://localhost:8080").ok, false);
    assert.equal(parseQbitBaseUrl("http://[::1]:8080").ok, false);
    assert.equal(parseQbitBaseUrl("http://169.254.169.254/latest").ok, false);
    assert.equal(parseQbitBaseUrl("http://[fe80::1]:8080").ok, false);

    process.env[SEEDBOX_ALLOW_LOOPBACK_ENV] = "true";
    assert.equal(parseQbitBaseUrl("http://127.0.0.1:8080").ok, true);
    assert.equal(parseQbitBaseUrl("http://[::1]:8080").ok, true);
    assert.equal(parseQbitBaseUrl("http://169.254.169.254/latest").ok, false);
  } finally {
    if (saved === undefined) {
      delete process.env[SEEDBOX_ALLOW_LOOPBACK_ENV];
    } else {
      process.env[SEEDBOX_ALLOW_LOOPBACK_ENV] = saved;
    }
  }
});

test("parseQbitBaseUrl accepts RFC1918/ULA hosts and rejects metadata hosts", () => {
  for (const url of [
    "http://10.0.0.5:8080",
    "http://172.16.1.1:8080",
    "http://192.168.1.50:8080",
    "http://[fd00::1]:8080",
  ]) {
    assert.equal(parseQbitBaseUrl(url).ok, true, `${url} must be allowed`);
  }
  for (const url of ["http://169.254.169.254", "http://[fe80::1]:8080"]) {
    assert.equal(parseQbitBaseUrl(url).ok, false, `${url} must be rejected`);
  }
});

test("constructor rejects non-routable hosts with invalid_config", () => {
  for (const baseUrl of [
    "http://127.0.0.1:8080",
    "http://169.254.169.254",
    "http://[fe80::1]",
  ]) {
    assert.throws(
      () => new QBittorrentClient(baseConfig({ baseUrl })),
      (error: unknown) => {
        assert.ok(error instanceof QBittorrentError);
        assert.equal(error.code, "invalid_config");
        return true;
      },
      `expected ${JSON.stringify(baseUrl)} to be rejected`,
    );
  }
});
