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
  - `POST /config` — authenticated; validates the WebUI `baseUrl` (absolute `http(s)`, no embedded credentials), stores `baseUrl`/credentials (encrypting the password, see below), and resets cached sessions.
  - `GET /torrents` — authenticated; returns `{ torrents }` or a typed `{ error, code }` response; client failures never surface as unhandled rejections.
  - `POST /torrents` — authenticated; adds a torrent from a magnet/URL or base64 `.torrent` (`url`, `torrentFile`, `torrentFileName`, `savePath`, `category`, `paused`).
  - `POST /torrents/:hash/pause`, `POST /torrents/:hash/resume`, `DELETE /torrents/:hash` — authenticated; `deleteFiles` is honored on delete.
  - `GET /transfer` — authenticated; global transfer statistics.
  - `GET /health` — authenticated; connection health probe (reachability, authentication, latency) that never throws.
  - `GET/POST /depots`, `DELETE /depots/:id` — authenticated registry of remote/seedbox depot endpoints with per-depot enable/disable and priority.
  - `POST /mappings` and `GET /mappings`, `GET /mappings/:gameId` — authenticated; associate a torrent hash or content path with a Drop game.
- **`seedbox:progress` WebSocket channel** — authenticated users only (subscription authorizer + per-message `userId` gate). Subscribers receive an immediate torrent snapshot, then periodic snapshots (default 15s) broadcast on the channel. `{"type":"unsubscribe"}` stops updates; `{"type":"ping"}` replies with `pong`.

### Roadmap (not implemented yet)

The repository name and earlier docs referenced remote streaming depots and game-library integration. Those features do **not** exist yet:

- Remote / mountable streaming depots (Heretek-Games/drop-seedbox#3, #4) — the depot registry, health probe and validation exist, but no torrent-backed chunk backend
- Play-while-download streaming (Heretek-Games/drop-seedbox#5)
- SSRF host allowlisting and rate limits (Heretek-Games/drop-seedbox#6; scheme/host validation and embedded-credential rejection are implemented, but arbitrary private-range hosts are still permitted)
- Admin UI (Heretek-Games/drop-seedbox#7 — the health/depot monitoring backend is in place; a rendered admin page is not)

Progress updates are polled snapshots of the torrent list, not byte-level or per-peer real-time telemetry.

## Security invariants

- Credentials and session cookies (`SID`) are never logged. Error messages and log lines contain only status codes and error classifications.
- Every route (`/config`, `/torrents`, `/transfer`, `/health`, `/depots`, `/mappings`) requires an authenticated `userId`; unauthenticated callers receive `{ error, code: "unauthorized" }`.
- The qBittorrent password is never persisted in plaintext. Set `DROP_SEEDBOX_CONFIG_KEY` (32 bytes as 64 hex characters or base64) to enable credential storage; `POST /config` refuses to store a password without it. Stored passwords are encrypted with AES-256-GCM.
- `baseUrl` must be an absolute `http(s)` URL without embedded credentials.
- Outbound requests send a `Referer`/`Origin` matching the WebUI host (required by some qBittorrent CSRF configurations).
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
