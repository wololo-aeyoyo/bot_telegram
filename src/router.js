import { Ollama } from "ollama";
import { config } from "./config.js";
import { TOOLS } from "./tools/index.js";

const ollama = new Ollama({ host: config.ollama.host });

const SYSTEM_PROMPT = `You are a helpful Telegram assistant. Use the provided tools when the user asks to download a video or audio, add a song to Spotify, or search for images. Otherwise, just reply conversationally. Keep replies short — this is a chat app.`;

/**
 * Send the user's message (plus rolling history) to Ollama with the tool
 * schemas. Returns either a tool call to dispatch or plain text to reply with.
 */
export async function routeMessage(userText, history) {
  const response = await ollama.chat({
    model: config.ollama.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: userText },
    ],
    tools: TOOLS,
  });

  const msg = response.message;

  if (msg.tool_calls?.length) {
    const call = msg.tool_calls[0];
    return { type: "tool", name: call.function.name, args: call.function.arguments };
  }

  return { type: "text", content: msg.content };
}
