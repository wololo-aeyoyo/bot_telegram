import SpotifyWebApi from "spotify-web-api-node";
import { config } from "../config.js";

// Refresh-token flow: the refresh token is set once at startup; the access
// token is refreshed lazily before each request and cached until expiry.
// Requires scopes: playlist-modify-public, playlist-modify-private
// (plus playlist-read-private for the playlist-name lookup).

const api = new SpotifyWebApi({
  clientId: config.spotify.clientId,
  clientSecret: config.spotify.clientSecret,
  refreshToken: config.spotify.refreshToken,
});

let tokenExpiresAt = 0;

async function ensureAccessToken() {
  if (Date.now() < tokenExpiresAt - 30_000) return;
  const { body } = await api.refreshAccessToken();
  api.setAccessToken(body.access_token);
  tokenExpiresAt = Date.now() + body.expires_in * 1000;
}

async function resolvePlaylistId(playlistName) {
  if (!playlistName) return config.spotify.defaultPlaylistId;

  const { body } = await api.getUserPlaylists({ limit: 50 });
  const match = body.items.find(
    (p) => p.name.toLowerCase() === playlistName.toLowerCase()
  );
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
  await ensureAccessToken();

  const search = await api.searchTracks(songQuery, { limit: 1 });
  const track = search.body.tracks?.items?.[0];
  if (!track) {
    return `No Spotify track found for "${songQuery}".`;
  }

  const playlistId = await resolvePlaylistId(playlistName);
  if (!playlistId) {
    throw new Error("No playlist ID resolved and SPOTIFY_DEFAULT_PLAYLIST_ID is unset");
  }

  await api.addTracksToPlaylist(playlistId, [track.uri]);

  const artists = track.artists.map((a) => a.name).join(", ");
  return `🎵 Added "${track.name}" by ${artists} to the playlist.`;
}
