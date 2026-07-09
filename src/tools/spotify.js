import { config } from "../config.js";

// Plain-fetch Spotify client. The spotify-web-api-node package is
// unmaintained and still calls /playlists/{id}/tracks, which Spotify retired
// on 2026-02-11 in favor of /playlists/{id}/items (old path now 403s).
//
// Refresh-token flow: the access token is refreshed lazily before each
// request and cached until expiry. Requires scopes: playlist-modify-public,
// playlist-modify-private, playlist-read-private.

const ACCOUNTS_URL = "https://accounts.spotify.com/api/token";
const API_URL = "https://api.spotify.com/v1";

let accessToken = null;
let tokenExpiresAt = 0;

async function ensureAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 30_000) return;

  const res = await fetch(ACCOUNTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " +
        Buffer.from(`${config.spotify.clientId}:${config.spotify.clientSecret}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.spotify.refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`Spotify token refresh failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
}

async function spotifyFetch(path, options = {}) {
  await ensureAccessToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`Spotify API error on ${path}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function resolvePlaylistId(playlistName) {
  if (!playlistName) return config.spotify.defaultPlaylistId;

  const data = await spotifyFetch("/me/playlists?limit=50");
  const match = data.items.find((p) => p.name.toLowerCase() === playlistName.toLowerCase());
  return match?.id ?? config.spotify.defaultPlaylistId;
}

/**
 * Search for a track and add the top hit to a playlist.
 * Returns a human-readable confirmation string.
 */
export async function addToPlaylist(songQuery, playlistName) {
  if (!config.spotify.clientId || !config.spotify.refreshToken) {
    throw new Error("Spotify is not configured");
  }

  const search = await spotifyFetch(
    `/search?${new URLSearchParams({ q: songQuery, type: "track", limit: "1" })}`
  );
  const track = search.tracks?.items?.[0];
  if (!track) {
    return `No Spotify track found for "${songQuery}".`;
  }

  const playlistId = await resolvePlaylistId(playlistName);
  if (!playlistId) {
    throw new Error("No playlist ID resolved and SPOTIFY_DEFAULT_PLAYLIST_ID is unset");
  }

  await spotifyFetch(`/playlists/${playlistId}/items`, {
    method: "POST",
    body: JSON.stringify({ uris: [track.uri] }),
  });

  const artists = track.artists.map((a) => a.name).join(", ");
  return `🎵 Added "${track.name}" by ${artists} to the playlist.`;
}
