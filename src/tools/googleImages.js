import { config } from "../config.js";

const ENDPOINT = "https://www.googleapis.com/customsearch/v1";
const MAX_RESULTS = 5;

/**
 * Search Google Images via the Custom Search JSON API.
 * Returns a Telegram InputMediaPhoto array (for ctx.replyWithMediaGroup).
 */
export async function searchImages(query) {
  if (!config.googleCse.apiKey || !config.googleCse.cx) {
    throw new Error("Google Custom Search is not configured");
  }

  const params = new URLSearchParams({
    key: config.googleCse.apiKey,
    cx: config.googleCse.cx,
    searchType: "image",
    num: String(MAX_RESULTS),
    q: query,
  });

  const res = await fetch(`${ENDPOINT}?${params}`);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason ?? data?.error?.status;
    if (res.status === 429 || reason === "dailyLimitExceeded" || reason === "rateLimitExceeded") {
      throw new Error("Google Images daily quota exhausted (free tier is 100 queries/day) — try again tomorrow.");
    }
    throw new Error(`Google Images search failed: ${res.status} ${data?.error?.message ?? ""}`);
  }

  const items = data.items ?? [];
  if (!items.length) return [];

  return items.slice(0, MAX_RESULTS).map((item, i) => ({
    type: "photo",
    media: item.link,
    ...(i === 0 ? { caption: `Results for "${query}"` } : {}),
  }));
}
