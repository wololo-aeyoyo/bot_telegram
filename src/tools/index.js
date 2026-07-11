import { config } from "../config.js";
import { YtDlpClient } from "./ytdlp.js";
import { addToPlaylist } from "./spotify.js";
import { searchImages } from "./gelbooru.js";
import { withSpan } from "../tracing.js";

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
      description: "Search Gelbooru (anime/artwork imageboard) for images matching tags",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Space-separated Gelbooru tags; use underscores inside multi-word tags, e.g. 'hatsune_miku blue_hair'"
          }
        },
        required: ["query"]
      }
    }
  }
];

const ytdlp = new YtDlpClient(config.ytdlp);

// Telegram Bot API caps bot uploads at 50 MB; leave headroom for multipart overhead.
const MAX_TELEGRAM_UPLOAD_BYTES = 49 * 1024 * 1024;

function filenameFromContentDisposition(header) {
  const match = header?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Execute a tool call from the router.
 * Returns { type: "text", text }, { type: "media", media, fallbackText },
 * or { type: "video", buffer, filename, mimeType, fallbackText }.
 */
export async function dispatch(name, args) {
  return withSpan("tool.dispatch", { "tool.name": name }, () => dispatchTool(name, args));
}

async function dispatchTool(name, args) {
  switch (name) {
    case "download_video": {
      // Ask the backend for metadata first: if the estimated merged
      // (audio+video) size already exceeds the Telegram cap, skip streaming
      // entirely and upload to Chibisafe, saving a wasted full download.
      let approxSize = null;
      try {
        const info = await ytdlp.getInfo(args.url);
        approxSize = info.filesize_approx_bytes ?? null;
      } catch {
        // Metadata is best-effort; fall through to the stream path.
      }
      if (approxSize && approxSize > MAX_TELEGRAM_UPLOAD_BYTES) {
        const result = await ytdlp.download(args.url);
        return {
          type: "text",
          text: `✅ ${result.title} (${result.file_size_human})\n${result.chibisafe.url}`,
        };
      }

      // Prefer streaming the file into Telegram as a native video; only
      // possible when the size is known and under the bot upload limit.
      // filesize_approx is an estimate, so keep the Content-Length check.
      const stream = await ytdlp.stream(args.url);
      const size = Number(stream.headers.get("content-length"));

      if (size && size <= MAX_TELEGRAM_UPLOAD_BYTES) {
        const buffer = Buffer.from(await stream.arrayBuffer());
        const filename =
          filenameFromContentDisposition(stream.headers.get("content-disposition")) ?? "video.mp4";
        return {
          type: "video",
          buffer,
          filename,
          mimeType: stream.headers.get("content-type") ?? "",
          fallbackText: `Sent video: ${filename}`,
        };
      }

      // Too big (or size unknown) — drop the stream and fall back to a
      // Chibisafe link. Costs the backend a second download of the same URL.
      await stream.body?.cancel().catch(() => {});
      const result = await ytdlp.download(args.url);
      return {
        type: "text",
        text: `✅ ${result.title} (${result.file_size_human})\n${result.chibisafe.url}`,
      };
    }

    case "download_audio": {
      const result = await ytdlp.convertToMp3(args.url, args.audio_quality);
      return {
        type: "text",
        text: `🎧 ${result.title} (${result.audio_quality}, ${result.file_size_human})\n${result.chibisafe.url}`,
      };
    }

    case "add_to_spotify_playlist": {
      const text = await addToPlaylist(args.song_query, args.playlist_name);
      return { type: "text", text };
    }

    case "search_images": {
      const media = await searchImages(args.query);
      if (!media.length) {
        return { type: "text", text: `No image results for "${args.query}".` };
      }
      return { type: "media", media, fallbackText: `Found ${media.length} images for "${args.query}"` };
    }

    default:
      return { type: "text", text: `Unknown tool: ${name}` };
  }
}
