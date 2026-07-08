import { config } from "../config.js";

const ENDPOINT = "https://gelbooru.com/index.php";
const MAX_RESULTS = 5;
// Fetch extra posts so we can skip videos/oversized files and still fill the album.
const FETCH_LIMIT = 20;

const PHOTO_EXTENSIONS = /\.(jpe?g|png|webp)$/i;

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

  const photos = posts
    // Prefer the downscaled sample when Gelbooru provides one — Telegram
    // rejects photo URLs over 10 MB and full-size scans can exceed that.
    .map((p) => (p.sample_url ? p.sample_url : p.file_url))
    .filter((url) => url && PHOTO_EXTENSIONS.test(url))
    .slice(0, MAX_RESULTS);

  return photos.map((url, i) => ({
    type: "photo",
    media: url,
    ...(i === 0 ? { caption: `Gelbooru results for "${query}"` } : {}),
  }));
}
