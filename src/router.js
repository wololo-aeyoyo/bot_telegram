import { config } from "./config.js";
import { TOOLS } from "./tools/index.js";

const SYSTEM_PROMPT = `You are a helpful Telegram assistant. Use the provided tools when the user asks to download a video or audio, add a song to Spotify, or search for images. Otherwise, just reply conversationally. Keep replies short — this is a chat app.`;

/**
 * Send the user's message (plus rolling history) to an OpenAI-compatible
 * chat-completions endpoint (NVIDIA NIM, local Ollama at /v1, etc) with the
 * tool schemas. Returns either a tool call to dispatch or plain text.
 */
export async function routeMessage(userText, history) {
  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.llm.apiKey ? { Authorization: `Bearer ${config.llm.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.llm.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
        { role: "user", content: userText },
      ],
      tools: TOOLS,
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) {
    throw new Error(`LLM returned no message: ${JSON.stringify(data).slice(0, 500)}`);
  }

  if (msg.tool_calls?.length) {
    const call = msg.tool_calls[0];
    // OpenAI protocol sends arguments as a JSON string; some Ollama versions
    // send an object. Handle both.
    const rawArgs = call.function.arguments;
    const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
    return { type: "tool", name: call.function.name, args };
  }

  return { type: "text", content: msg.content };
}
