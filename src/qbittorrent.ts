export interface QbitConfig {
  baseUrl: string;
  username?: string;
  password?: string;
}

export interface QbitTorrent {
  hash: string;
  name: string;
  size: number;
  progress: number;
  dlspeed: number;
  state: string;
}

export class QBittorrentClient {
  private cookie: string | null = null;

  constructor(private readonly config: QbitConfig) {}

  async login(): Promise<boolean> {
    if (!this.config.username || !this.config.password) return true;
    const body = new URLSearchParams({
      username: this.config.username,
      password: this.config.password,
    });
    const res = await fetch(`${this.config.baseUrl}/api/v2/auth/login`, {
      method: "POST",
      body,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      this.cookie = setCookie.split(";")[0];
    }
    return res.ok;
  }

  async getTorrents(): Promise<QbitTorrent[]> {
    const headers: Record<string, string> = {};
    if (this.cookie) {
      headers.cookie = this.cookie;
    }
    const res = await fetch(`${this.config.baseUrl}/api/v2/torrents/info`, {
      headers,
    });
    if (!res.ok) {
      throw new Error(`qBittorrent API error: ${res.statusText}`);
    }
    return (await res.json()) as QbitTorrent[];
  }
}
