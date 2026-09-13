# AGENTS.md — Drop Seedbox contributor & AI agent guide

**Drop Seedbox** (`drop-seedbox`) manages qBittorrent WebUI integration and remote streaming depots for the Drop platform.

---

## 1. Architecture

- **`src/qbittorrent.ts`**: HTTP client for qBittorrent WebUI v2 API (`/api/v2/auth/login`, `/api/v2/torrents/info`).
- **`src/index.ts`**: Plugin implementation providing `/config` and `/torrents` endpoints, and `seedbox:progress` WebSocket channel.
- **Capabilities**: `routes`, `storage`, `network`, `websocket`.

---

## 2. Invariants

- **Credential Security**: Never log passwords or session cookies (`SID`).
- **Resilient Polling**: Implement backoff on unreachable seedbox endpoints.
