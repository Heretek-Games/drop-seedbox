# drop-seedbox

Seedbox and qBittorrent remote depot integration plugin for the [Drop](https://github.com/Heretek-Games/drop) game distribution platform.

Maintained by [Heretek Games](https://github.com/Heretek-Games/drop-seedbox).

## Overview

`drop-seedbox` bridges self-hosted Drop instances with headless torrent seedboxes:
1. **WebUI Integration**: Connects securely to qBittorrent via the v2 WebUI API.
2. **Remote Streaming Depots**: Surfaces remote seedbox storage as mountable or streaming depots in Drop's library system.
3. **Progress Telemetry**: Streams download and seeding metrics through WebSocket channels in real time.

Built on the `@drop/plugin-sdk`.
