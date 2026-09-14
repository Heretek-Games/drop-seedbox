# drop-seedbox

qBittorrent WebUI integration plugin for the [Drop](https://github.com/Heretek-Games/drop) game distribution platform, built on `@droposs/plugin-sdk` (^0.4.0).

Maintained by [Heretek Games](https://github.com/Heretek-Games/drop-seedbox).

## Status

### Implemented

- **qBittorrent WebUI v2 client** (`src/qbittorrent.ts`):
  - `POST /api/v2/auth/login` with explicit failures for missing credentials, non-OK responses, rejected logins, and missing session cookies.
  - `GET /api/v2/torrents/info` with configurable timeout (`AbortSignal.timeout`, default 10s), typed errors, exponential backoff for transient failures (timeouts, network errors, 5xx), and one-shot re-login when the session expires (401/403).
  - `POST /api/v2/torrents/add` (magnet/URL as form data, `.torrent` as multipart), `pause`/`resume`/`delete` actions, and `GET /api/v2/transfer/info`.
  - `checkHealth()` connection probe (reachability, authentication, latency) that never throws.
- **Plugin routes** (`src/index.ts`):
  - `POST /config` — authenticated; stores WebUI `baseUrl`/credentials and resets cached sessions.
  - `GET /torrents` — returns `{ torrents }` or a typed `{ error, code }` response; client failures never surface as unhandled rejections.
  - `POST /torrents` — authenticated; adds a torrent from a magnet/URL or base64 `.torrent` (`url`, `torrentFile`, `torrentFileName`, `savePath`, `category`, `paused`).
  - `POST /torrents/:hash/pause`, `POST /torrents/:hash/resume`, `DELETE /torrents/:hash` — authenticated; `deleteFiles` is honored on delete.
  - `GET /transfer` — global transfer statistics.
  - `POST /mappings` and `GET /mappings`, `GET /mappings/:gameId` — associate a torrent hash or content path with a Drop game.
- **`seedbox:progress` WebSocket channel** — authenticated users only (subscription authorizer + per-message `userId` gate). Subscribers receive an immediate torrent snapshot, then periodic snapshots (default 15s) broadcast on the channel. `{"type":"unsubscribe"}` stops updates; `{"type":"ping"}` replies with `pong`.

### Roadmap (not implemented yet)

The repository name and earlier docs referenced remote streaming depots and game-library integration. Those features do **not** exist yet:

- Remote / mountable streaming depots (Heretek-Games/drop-seedbox#3, #4)
- Play-while-download streaming (Heretek-Games/drop-seedbox#5)
- SSRF protections and rate limits (Heretek-Games/drop-seedbox#6; the torrential depot chunk endpoint now supports opt-in authentication via `TORRENTIAL_REQUIRE_CHUNK_AUTH`)
- Admin UI + monitoring (Heretek-Games/drop-seedbox#7)

Progress updates are polled snapshots of the torrent list, not byte-level or per-peer real-time telemetry.

## Security invariants

- Credentials and session cookies (`SID`) are never logged. Error messages and log lines contain only status codes and error classifications.
- `POST /config` requires an authenticated `userId`.
- `seedbox:progress` subscriptions require an authenticated `userId`; anonymous subscribers are rejected by the registered subscription authorizer and by the handler.
- Outbound requests are bounded by a per-request timeout and retried with backoff so unreachable seedboxes cannot pin handlers indefinitely.

## Development

```bash
npm ci
npm run build
npm test
npm run typecheck
```

CI runs the same commands on Node 22 (`.github/workflows/ci.yml`).
