# Telegram Multi-Tool Bot (LLM-routed)

A Telegram bot that uses an LLM (any OpenAI-compatible endpoint — NVIDIA NIM,
local Ollama, etc) as a function-calling router to decide between four
capabilities:

1. **Download video** via a self-hosted yt-dlp FastAPI backend
2. **Extract audio as MP3** via the same backend
3. **Add a song to a Spotify playlist**
4. **Search Gelbooru images** (sent as a photo album)

Anything that doesn't match a tool falls back to normal conversational chat.

## Requirements

- Node.js 20+
- An OpenAI-compatible LLM endpoint with tool calling:
  - **NVIDIA NIM** (default): free dev credits at [build.nvidia.com](https://build.nvidia.com) —
    open a model page and "Get API Key" for an `nvapi-` key
  - **Local Ollama**: `ollama pull llama3.1` (or qwen2.5, mistral-nemo) and
    point `LLM_BASE_URL` at `http://localhost:11434/v1`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- (Optional, per tool) yt-dlp backend credentials, Spotify app credentials, Gelbooru API credentials

## Install

```sh
npm install
```

## Configure

```sh
cp .env.example .env
```

Then fill in `.env`:

- **TELEGRAM_BOT_TOKEN** — from @BotFather
- **TELEGRAM_ALLOWED_USER_IDS** — comma-separated Telegram user IDs; everyone
  else is silently ignored
- **LLM_BASE_URL / LLM_MODEL / LLM_API_KEY** — the OpenAI-compatible endpoint,
  model name, and API key to route with (see `.env.example` for the NVIDIA
  and local-Ollama presets)
- **YTDLP_*** — base URL + credentials for the yt-dlp FastAPI backend
- **SPOTIFY_*** — client ID/secret, a refresh token, and the default playlist ID:
  1. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
     and add `http://127.0.0.1:8888/callback` as a Redirect URI
  2. Put the client ID/secret in `.env`, then run `npm run spotify-auth` —
     it opens the consent flow with the right scopes (`playlist-modify-public`,
     `playlist-modify-private`, `playlist-read-private`) and prints the
     `SPOTIFY_REFRESH_TOKEN` to paste into `.env`
  3. For the playlist ID: Share → "Copy link to playlist" in the Spotify app;
     the ID is the segment after `/playlist/` in the URL
- **GELBOORU_API_KEY / GELBOORU_USER_ID** — required for the image tool
  (anonymous API access gets a 401): register at gelbooru.com, then
  My Account → Options → API Access Credentials. `GELBOORU_RATING` filters
  results (`general` by default; `all` disables the filter).

Tool credentials are optional at startup — a missing group just disables that
tool (you'll get a warning in the logs and a friendly error in chat if it's
invoked anyway).

## Run

```sh
node src/index.js
```

Bot commands: `/start` (greeting), `/reset` (clear conversation history).

## Notes

- Conversation history and the yt-dlp auth token live in an in-memory Map
  (`src/session.js`, `src/tools/ytdlp.js`) — restart loses them. Swap in
  Redis/Postgres if you need persistence or multiple replicas.
- Long downloads show a "Working on it..." placeholder that gets edited in
  place when the result arrives.
- Video downloads under ~49 MB are streamed from the backend (`POST
  /api/stream`) and sent as a native Telegram video; larger files fall back
  to a Chibisafe link via `POST /api/download` (which re-downloads
  server-side, since the streamed copy is deleted after the stream ends).
