# AGENTS.md — Drop Seedbox contributor & AI agent guide

**Drop Seedbox** (`drop-seedbox`) manages qBittorrent WebUI integration for the Drop platform. Remote streaming depots are roadmap work, not shipped.

---

## 1. Architecture

- **`src/qbittorrent.ts`**: HTTP client for qBittorrent WebUI v2 API (`/api/v2/auth/login`, `/api/v2/torrents/info|add|pause|resume|delete`, `/api/v2/transfer/info`), with typed errors, per-request timeouts, exponential backoff, session re-login, and a connection health probe.
- **`src/index.ts`**: Plugin implementation providing `/config`, `/torrents` (list/add/manage), `/transfer`, `/health`, `/depots`, and `/mappings` endpoints, and the `seedbox:progress` WebSocket channel (authenticated periodic torrent snapshots).
- **`src/secrets.ts`**: AES-256-GCM at-rest encryption for stored credentials, keyed by `DROP_SEEDBOX_CONFIG_KEY`.
- **Capabilities**: `routes`, `storage`, `network`, `websocket`, `events`.

---

## 2. Invariants

- **Credential Security**: Never log passwords or session cookies (`SID`); never persist the password in plaintext (encrypt with `DROP_SEEDBOX_CONFIG_KEY` via `src/secrets.ts`).
- **Authorization**: Every route requires an authenticated `userId`; return `{ error, code: "unauthorized" }` otherwise.
- **Resilient Polling**: Implement backoff on unreachable seedbox endpoints; every request carries a timeout and re-authenticates on 401/403.
- **Typed Failures**: Routes and WS handlers return typed `{ error, code }` responses instead of unhandled rejections.
