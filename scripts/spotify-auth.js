// One-shot helper: runs the Spotify authorization-code flow locally and
// prints the refresh token to put in .env as SPOTIFY_REFRESH_TOKEN.
//
// Prerequisites:
//   1. Create an app at https://developer.spotify.com/dashboard
//   2. In the app settings, add this exact Redirect URI:
//        http://127.0.0.1:8888/callback
//      (Spotify no longer accepts "localhost" — use the loopback IP.)
//   3. Put SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env
//
// Run:  node scripts/spotify-auth.js

import "dotenv/config";
import http from "node:http";
import crypto from "node:crypto";

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env first.");
  process.exit(1);
}

const PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = "playlist-modify-public playlist-modify-private playlist-read-private";
const state = crypto.randomBytes(16).toString("hex");

const authUrl =
  "https://accounts.spotify.com/authorize?" +
  new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }

  const respond = (status, message) => {
    res.writeHead(status, { "Content-Type": "text/html" });
    res.end(`<body style="font-family:sans-serif"><h2>${message}</h2>You can close this tab.</body>`);
  };

  try {
    if (url.searchParams.get("state") !== state) {
      respond(400, "State mismatch — restart the script and try again.");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      respond(400, `Spotify returned an error: ${error}`);
      console.error(`Authorization failed: ${error}`);
      process.exit(1);
    }

    const code = url.searchParams.get("code");
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.refresh_token) {
      respond(500, "Token exchange failed — check the terminal.");
      console.error("Token exchange failed:", tokens);
      process.exit(1);
    }

    respond(200, "✅ Success!");
    console.log("\nAdd this to your .env:\n");
    console.log(`SPOTIFY_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    console.log(`Granted scopes: ${tokens.scope}`);
  } finally {
    server.close();
    // Give the response a moment to flush before the process exits.
    setTimeout(() => process.exit(0), 100);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Open this URL in your browser and approve access:\n");
  console.log(authUrl + "\n");
  console.log(`Waiting for Spotify to redirect to ${REDIRECT_URI} ...`);
});
