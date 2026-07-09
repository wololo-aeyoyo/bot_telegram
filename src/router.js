import { config } from "./config.js";
import { TOOLS } from "./tools/index.js";

const SYSTEM_PROMPT = `You are a helpful Telegram assistant. Use the provided tools ONLY when the user asks to download a video or audio, add a song to Spotify, or search for images. For anything else — greetings, questions, chat — reply directly with plain text; do NOT invent tools that are not in the list. Keep replies short — this is a chat app.`;

const KNOWN_TOOLS = new Set(TOOLS.map((t) => t.function.name));

async function chatCompletion(messages, withTools) {
  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.llm.apiKey ? { Authorization: `Bearer ${config.llm.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.llm.model,
      messages,
      ...(withTools ? { tools: TOOLS } : {}),
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
  return msg;
}

/**
 * Send the user's message (plus rolling history) to an OpenAI-compatible
 * chat-completions endpoint (NVIDIA NIM, local Ollama at /v1, etc) with the
 * tool schemas. Returns either a tool call to dispatch or plain text.
 */
export async function routeMessage(userText, history) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userText },
  ];

  let msg = await chatCompletion(messages, true);

  if (msg.tool_calls?.length) {
    const call = msg.tool_calls[0];

    if (KNOWN_TOOLS.has(call.function.name)) {
      // OpenAI protocol sends arguments as a JSON string; some Ollama
      // versions send an object. Handle both.
      const rawArgs = call.function.arguments;
      const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
      return { type: "tool", name: call.function.name, args };
    }

    // The model hallucinated a tool that doesn't exist (small models do this
    // for plain chat, e.g. a made-up "respond" tool). Re-ask without tools
    // to force a plain-text reply.
    msg = await chatCompletion(messages, false);
  }

  return { type: "text", content: msg.content };
}
