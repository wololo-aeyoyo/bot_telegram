import { config } from "../config.js";
import { logger } from "../logger.js";

const ENDPOINT = "https://gelbooru.com/index.php";
const MAX_RESULTS = 5;
// Fetch extra posts so we can skip videos/oversized files and still fill the album.
const FETCH_LIMIT = 20;

const PHOTO_EXTENSIONS = /\.(jpe?g|png|webp)$/i;

// Telegram photo limits: 10 MB per file, width + height <= 10000 px.
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_DIMENSION_SUM = 10000;

async function downloadImage(url) {
  const res = await fetch(url, {
    // Without a gelbooru.com Referer the CDN hotlink protection answers with
    // the post's HTML page (status 200!) instead of the image bytes.
    headers: {
      Referer: "https://gelbooru.com/",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
    },
  });
  if (!res.ok) throw new Error(`image fetch ${res.status}`);
  if (!res.headers.get("content-type")?.startsWith("image/")) {
    throw new Error(`got ${res.headers.get("content-type")} instead of an image`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_PHOTO_BYTES) {
    throw new Error(`image size ${buffer.length} outside Telegram limits`);
  }
  return buffer;
}

/**
 * Search Gelbooru posts by tags.
 * Returns a Telegram InputMediaPhoto array (for ctx.replyWithMediaGroup).
 */
export async function searchImages(query) {
  if (!config.gelbooru.apiKey || !config.gelbooru.userId) {
    throw new Error("Gelbooru is not configured (GELBOORU_API_KEY / GELBOORU_USER_ID)");
  }

  // Gelbooru expects space-separated tags with underscores inside multi-word
  // tags; the tool description asks the model for that format already.
  let tags = query.trim().replace(/,/g, " ").replace(/\s+/g, " ");
  if (config.gelbooru.rating !== "all") {
    tags += ` rating:${config.gelbooru.rating}`;
  }
  // Randomize server-side so repeat searches don't return the same newest
  // posts every time.
  tags += " sort:random";

  const params = new URLSearchParams({
    page: "dapi",
    s: "post",
    q: "index",
    json: "1",
    limit: String(FETCH_LIMIT),
    tags,
  });
  params.set("api_key", config.gelbooru.apiKey);
  params.set("user_id", config.gelbooru.userId);

  const res = await fetch(`${ENDPOINT}?${params}`);
  if (!res.ok) {
    throw new Error(`Gelbooru search failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const posts = data.post ?? [];

  const candidates = posts
    // Prefer the downscaled sample when Gelbooru provides one — full-size
    // scans can blow past Telegram's 10 MB / 10000 px photo limits.
    .map((p) =>
      p.sample_url
        ? { url: p.sample_url, width: p.sample_width, height: p.sample_height }
        : { url: p.file_url, width: p.width, height: p.height }
    )
    .filter(
      (c) =>
        c.url &&
        PHOTO_EXTENSIONS.test(c.url) &&
        (c.width ?? 0) + (c.height ?? 0) <= MAX_DIMENSION_SUM
    );

  // Download the images ourselves and upload the bytes to Telegram.
  // Passing Gelbooru URLs straight through makes Telegram's servers fetch
  // them, and Gelbooru blocks that (-> WEBPAGE_MEDIA_EMPTY kills the whole
  // album). A post that fails to download is simply skipped.
  const photos = [];
  for (const c of candidates) {
    if (photos.length >= MAX_RESULTS) break;
    try {
      photos.push(await downloadImage(c.url));
    } catch (err) {
      logger.warn({ url: c.url, err: err.message }, "gelbooru: skipping image");
    }
  }

  return photos.map((buffer, i) => ({
    type: "photo",
    media: { source: buffer },
    ...(i === 0 ? { caption: `Gelbooru results for "${query}"` } : {}),
  }));
}
