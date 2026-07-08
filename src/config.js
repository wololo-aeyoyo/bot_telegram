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
  // Any OpenAI-compatible chat-completions provider: NVIDIA NIM, local
  // Ollama (http://localhost:11434/v1), etc.
  llm: {
    baseUrl: optional("LLM_BASE_URL", "https://integrate.api.nvidia.com/v1").replace(/\/$/, ""),
    model: optional("LLM_MODEL", "moonshotai/kimi-k2.5-instruct"),
    apiKey: optional("LLM_API_KEY"),
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
  gelbooru: {
    apiKey: optional("GELBOORU_API_KEY"),
    userId: optional("GELBOORU_USER_ID"),
    // general | sensitive | questionable | explicit | all (no filter)
    rating: optional("GELBOORU_RATING", "general"),
  },
};

// Tool credentials are optional at boot so the bot can run with a subset of
// capabilities; warn so a misconfigured deploy is visible in the logs.
if (!config.llm.apiKey && !config.llm.baseUrl.includes("localhost") && !config.llm.baseUrl.includes("127.0.0.1")) {
  console.warn("[config] LLM_API_KEY is empty — a remote provider like NVIDIA will reject requests");
}

for (const [group, keys] of [
  ["ytdlp", ["baseUrl", "username", "password"]],
  ["spotify", ["clientId", "clientSecret", "refreshToken", "defaultPlaylistId"]],
  ["gelbooru", ["apiKey", "userId"]],
]) {
  const missing = keys.filter((k) => !config[group][k]);
  if (missing.length) {
    console.warn(`[config] ${group} not fully configured (missing: ${missing.join(", ")}) — that tool will fail if invoked`);
  }
}
