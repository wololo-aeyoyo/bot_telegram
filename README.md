# Telegram Multi-Tool Bot (Ollama-routed)

A Telegram bot that uses a local Ollama model as a function-calling router to
decide between four capabilities:

1. **Download video** via a self-hosted yt-dlp FastAPI backend
2. **Extract audio as MP3** via the same backend
3. **Add a song to a Spotify playlist**
4. **Search Google Images** (sent as a photo album)

Anything that doesn't match a tool falls back to normal conversational chat.

## Requirements

- Node.js 20+
- A running [Ollama](https://ollama.com) instance with a tool-calling model
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- (Optional, per tool) yt-dlp backend credentials, Spotify app credentials, Google CSE key

## Install

```sh
npm install
```

Pull an Ollama model that supports tool calling:

```sh
ollama pull llama3.1
# alternatives: qwen2.5, mistral-nemo
```

## Configure

```sh
cp .env.example .env
```

Then fill in `.env`:

- **TELEGRAM_BOT_TOKEN** — from @BotFather
- **TELEGRAM_ALLOWED_USER_IDS** — comma-separated Telegram user IDs; everyone
  else is silently ignored
- **OLLAMA_HOST / OLLAMA_MODEL** — where Ollama runs and which model to route with
- **YTDLP_*** — base URL + credentials for the yt-dlp FastAPI backend
- **SPOTIFY_*** — client ID/secret, a refresh token, and the default playlist ID.
  The refresh token must be minted with scopes `playlist-modify-public`,
  `playlist-modify-private`, and `playlist-read-private` (the last one is
  needed to look up playlists by name)
- **GOOGLE_CSE_API_KEY / GOOGLE_CSE_CX** — Google Custom Search JSON API key
  and search-engine ID (with image search enabled). Free tier is 100 queries/day.

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
