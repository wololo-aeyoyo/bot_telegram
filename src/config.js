import "dotenv/config";

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function optional(name, fallback = "") {
  return process.env[name] || fallback;
}

export const config = {
  telegram: {
    botToken: required("TELEGRAM_BOT_TOKEN"),
    allowedUserIds: required("TELEGRAM_ALLOWED_USER_IDS")
      .split(",")
      .map((id) => Number(id.trim()))
      .filter((id) => Number.isInteger(id)),
  },
  ollama: {
    host: optional("OLLAMA_HOST", "http://localhost:11434"),
    model: optional("OLLAMA_MODEL", "llama3.1"),
  },
  ytdlp: {
    baseUrl: optional("YTDLP_BASE_URL"),
    username: optional("YTDLP_USERNAME"),
    password: optional("YTDLP_PASSWORD"),
  },
  spotify: {
    clientId: optional("SPOTIFY_CLIENT_ID"),
    clientSecret: optional("SPOTIFY_CLIENT_SECRET"),
    refreshToken: optional("SPOTIFY_REFRESH_TOKEN"),
    defaultPlaylistId: optional("SPOTIFY_DEFAULT_PLAYLIST_ID"),
  },
  googleCse: {
    apiKey: optional("GOOGLE_CSE_API_KEY"),
    cx: optional("GOOGLE_CSE_CX"),
  },
};

// Tool credentials are optional at boot so the bot can run with a subset of
// capabilities; warn so a misconfigured deploy is visible in the logs.
for (const [group, keys] of [
  ["ytdlp", ["baseUrl", "username", "password"]],
  ["spotify", ["clientId", "clientSecret", "refreshToken", "defaultPlaylistId"]],
  ["googleCse", ["apiKey", "cx"]],
]) {
  const missing = keys.filter((k) => !config[group][k]);
  if (missing.length) {
    console.warn(`[config] ${group} not fully configured (missing: ${missing.join(", ")}) — that tool will fail if invoked`);
  }
}
