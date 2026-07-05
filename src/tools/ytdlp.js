// Client for the self-hosted yt-dlp FastAPI backend.
// Auth: POST /api/auth/login -> { access_token, token_type }; all other
// endpoints (except /api/health and /api/auth/*) take Authorization: Bearer.

export class YtDlpClient {
  #baseUrl;
  #username;
  #password;
  #token = null;

  constructor({ baseUrl, username, password }) {
    this.#baseUrl = baseUrl?.replace(/\/$/, "");
    this.#username = username;
    this.#password = password;
  }

  async #login() {
    const res = await fetch(`${this.#baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: this.#username, password: this.#password }),
    });
    if (!res.ok) {
      throw new Error(`yt-dlp login failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    this.#token = data.access_token;
  }

  async #authedFetchRaw(path, options = {}) {
    if (!this.#baseUrl) throw new Error("yt-dlp backend is not configured");
    if (!this.#token) await this.#login();

    const doFetch = () =>
      fetch(`${this.#baseUrl}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
          Authorization: `Bearer ${this.#token}`,
        },
      });

    let res = await doFetch();
    if (res.status === 401) {
      // Token expired — re-login once and retry.
      await this.#login();
      res = await doFetch();
    }
    if (!res.ok) {
      throw new Error(`yt-dlp API error on ${path}: ${res.status} ${await res.text()}`);
    }
    return res;
  }

  async #authedFetch(path, options = {}) {
    const res = await this.#authedFetchRaw(path, options);
    return res.json();
  }

  /** POST /api/download -> { success, title, filename, file_size_human, chibisafe: { url, name, uuid } } */
  async download(url) {
    const result = await this.#authedFetch("/api/download", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    if (result.success === false) throw new Error(`yt-dlp download reported failure for ${url}`);
    return result;
  }

  /** POST /api/convert -> same shape as download() plus audio_quality */
  async convertToMp3(url, audioQuality = "192k") {
    const result = await this.#authedFetch("/api/convert", {
      method: "POST",
      body: JSON.stringify({ url, audio_quality: audioQuality }),
    });
    if (result.success === false) throw new Error(`yt-dlp convert reported failure for ${url}`);
    return result;
  }

  /**
   * POST /api/stream — downloads server-side, then streams the file bytes
   * directly to us (the server deletes its copy when the stream ends).
   * Returns the raw fetch Response so the caller can inspect headers before
   * deciding to buffer the body.
   */
  async stream(url) {
    return this.#authedFetchRaw("/api/stream", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  }

  /** GET /api/info?url=... */
  async getInfo(url) {
    return this.#authedFetch(`/api/info?url=${encodeURIComponent(url)}`);
  }
}
