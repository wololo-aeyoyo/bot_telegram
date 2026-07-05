# Project: Telegram Multi-Tool Bot (Ollama-routed, Node.js)

Build a Telegram bot in **Node.js** that uses a local **Ollama** model as a
function-calling router to decide between four capabilities:

1. Download video/audio via a self-hosted **yt-dlp FastAPI backend**
2. Add a song to a **Spotify** playlist
3. Search **Google Images**
4. Fall back to normal **conversational chat**

The bot must run as a standalone Node process (Docker-friendly, fits into an
existing Kubernetes/Tailscale homelab).

---

## 1. Tech stack

- **Runtime**: Node.js 20+, ES modules (`"type": "module"` in package.json)
- **Telegram**: `telegraf` (preferred over `node-telegram-bot-api` — cleaner
  middleware model, built-in session support)
- **Ollama**: `ollama` npm package (official JS client, supports `tools`)
- **HTTP client**: native `fetch` (Node 20+ has it built in — no axios needed)
- **Spotify**: `spotify-web-api-node`
- **Google Images**: Google Custom Search JSON API via plain `fetch`
- **Env config**: `dotenv`
- **Process state**: in-memory Map for now (per-user conversation history +
  JWT cache); note where Redis/Postgres could replace this later

---

## 2. Project structure

```
telegram-ollama-bot/
├── package.json
├── .env.example
├── src/
│   ├── index.js              # entrypoint, wires up Telegraf + handlers
│   ├── config.js             # loads/validates env vars
│   ├── router.js             # Ollama tool-calling router
│   ├── tools/
│   │   ├── index.js          # TOOLS schema array + dispatch()
│   │   ├── ytdlp.js          # yt-dlp API client (matches provided OpenAPI spec)
│   │   ├── spotify.js        # Spotify client (OAuth refresh-token flow)
│   │   └── googleImages.js   # Google Custom Search image client
│   └── session.js            # per-chat conversation history + ytdlp token cache
└── README.md
```

---

## 3. Environment variables (`.env.example`)

```
# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321   # comma-separated whitelist

# Ollama
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.1                            # or qwen2.5, mistral-nemo, kimi-k2.6:cloud

# yt-dlp backend (matches uploaded openapi.json)
YTDLP_BASE_URL=http://ytdlp-backend.internal:8000
YTDLP_USERNAME=
YTDLP_PASSWORD=

# Spotify
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
SPOTIFY_REFRESH_TOKEN=
SPOTIFY_DEFAULT_PLAYLIST_ID=

# Google Custom Search (Images)
GOOGLE_CSE_API_KEY=
GOOGLE_CSE_CX=
```

---

## 4. Tool schema (`src/tools/index.js`)

Define exactly these four tools for Ollama's `tools` parameter. Tool names
map 1:1 to dispatch functions — no boolean flags where a separate tool name
is clearer (e.g. `download_video` vs `download_audio` instead of one tool
with an `audio_only` flag).

```js
export const TOOLS = [
  {
    type: "function",
    function: {
      name: "download_video",
      description: "Download a video from a URL (YouTube, Twitter/X, TikTok, Reddit, etc) and return a shareable link",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The video URL" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "download_audio",
      description: "Extract a video's audio as MP3 and return a shareable link",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          audio_quality: { type: "string", enum: ["96k", "128k", "192k", "320k"] }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "add_to_spotify_playlist",
      description: "Search for a song and add it to a Spotify playlist",
      parameters: {
        type: "object",
        properties: {
          song_query: { type: "string", description: "Song name and/or artist" },
          playlist_name: { type: "string", description: "Optional; defaults to configured playlist" }
        },
        required: ["song_query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_images",
      description: "Search Google Images for a query and return image results",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      }
    }
  }
];
```

`dispatch(name, args)` in the same file switches on `name` and calls the
matching client in `src/tools/`. If Ollama returns plain text instead of a
tool call, that text is the chatbot reply — no extra logic needed.

---

## 5. yt-dlp client (`src/tools/ytdlp.js`)

Must match the attached `openapi.json` exactly:

- `POST /api/auth/login` → `{ access_token, token_type }` — call once at
  startup, cache token, re-login automatically on a `401`
- `POST /api/download` → body `{ url, quality?, format_id? }` → response has
  `title`, `filename`, `file_size_human`, `chibisafe: { url, name, uuid }`
- `POST /api/convert` → body `{ url, audio_quality? }` (enum `96k|128k|192k|320k`,
  default `192k`) → same shape as above plus `audio_quality`
- All endpoints except `/api/health` and `/api/auth/*` require
  `Authorization: Bearer <token>`
- Bot replies with the `title` + `chibisafe.url` link

```js
class YtDlpClient {
  constructor({ baseUrl, username, password }) { /* ... */ }
  async #login() { /* POST /api/auth/login, cache token */ }
  async #authedFetch(path, options) { /* attach bearer, retry once on 401 */ }
  async download(url) { /* POST /api/download */ }
  async convertToMp3(url, audioQuality = "192k") { /* POST /api/convert */ }
  async getInfo(url) { /* GET /api/info?url=... */ }
}
```

Downloads can take 10–30+ seconds. In the Telegraf handler: send a
placeholder message ("Downloading...") immediately, then
`ctx.telegram.editMessageText(...)` once the client resolves — don't block
silently.

---

## 6. Spotify client (`src/tools/spotify.js`)

- Use `spotify-web-api-node` with the **refresh token** flow (not
  Authorization Code per-request) — set `refreshToken` once at startup,
  call `refreshAccessToken()` on a timer or lazily before each request, cache
  the resulting access token + expiry in memory.
- Flow: `searchTracks(query, { limit: 1 })` → grab the top hit's URI →
  `addTracksToPlaylist(playlistId, [uri])`.
- If `playlist_name` is provided and doesn't match `SPOTIFY_DEFAULT_PLAYLIST_ID`,
  look it up via `getUserPlaylists()` and match by name (case-insensitive);
  fall back to the default playlist ID if no match.

---

## 7. Google Images client (`src/tools/googleImages.js`)

- `GET https://www.googleapis.com/customsearch/v1?key=...&cx=...&searchType=image&q=...`
- Return top 3–5 results as Telegram `InputMediaPhoto` array so the bot can
  send an album via `ctx.replyWithMediaGroup()` instead of just links.
- Handle daily quota errors (free tier is 100 queries/day) gracefully with a
  clear message rather than a stack trace.

---

## 8. Router (`src/router.js`)

```js
import ollama from "ollama";
import { TOOLS, dispatch } from "./tools/index.js";

export async function routeMessage(userText, history) {
  const response = await ollama.chat({
    model: process.env.OLLAMA_MODEL,
    messages: [...history, { role: "user", content: userText }],
    tools: TOOLS
  });

  const msg = response.message;

  if (msg.tool_calls?.length) {
    const call = msg.tool_calls[0];
    return { type: "tool", name: call.function.name, args: call.function.arguments };
  }

  return { type: "text", content: msg.content };
}
```

---

## 9. Telegram bot (`src/index.js`)

- Use `telegraf`'s `bot.on("text", handler)`.
- **Whitelist check first**: reject/ignore any `ctx.from.id` not in
  `TELEGRAM_ALLOWED_USER_IDS` before doing anything else (especially before
  hitting Spotify/download tools).
- Maintain a small rolling history per chat ID (last ~10 messages) in
  `src/session.js` so the model has conversational context; trim aggressively
  since local models have smaller context windows than cloud ones.
- On tool routing:
  1. `await ctx.reply("Working on it...")`, keep the returned message object
  2. `const result = await dispatch(name, args)`
  3. `await ctx.telegram.editMessageText(ctx.chat.id, placeholder.message_id, undefined, result)`
- On plain text routing: just `ctx.reply(msg.content)`.
- Wrap every handler body in try/catch; on error, edit the placeholder to a
  friendly failure message and log the real error server-side — never leak
  stack traces to Telegram.

---

## 10. package.json dependencies

```json
{
  "type": "module",
  "dependencies": {
    "telegraf": "^4.16.3",
    "ollama": "^0.5.9",
    "spotify-web-api-node": "^5.0.2",
    "dotenv": "^16.4.5"
  }
}
```

(No axios — Node 20's built-in `fetch` covers the yt-dlp and Google clients.)

---

## 11. What Claude should do with this file

Read through this spec end-to-end, then:

1. Scaffold the full directory structure above
2. Implement each file per the section describing it
3. Write a `.env.example` with every variable listed in Section 3
4. Write a short `README.md` covering: install, configuring `.env`, pulling
   an Ollama model that supports tool calling (e.g. `ollama pull llama3.1`),
   and running with `node src/index.js`
5. Flag anywhere it had to make an assumption (e.g. exact Spotify scopes
   needed: `playlist-modify-public`, `playlist-modify-private`)

Do not add a database layer, Docker files, or CI in this first pass unless
asked — keep the initial scaffold runnable with just `node` + a `.env` file.
