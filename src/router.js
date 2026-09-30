import { config } from "./config.js";
import { TOOLS } from "./tools/index.js";
import { logger } from "./logger.js";
import { withSpan } from "./tracing.js";

const SYSTEM_PROMPT = `You are a helpful Telegram assistant. Use the provided tools ONLY when the user asks to download a video or audio, add a song to Spotify, or search for images. If the user sends a link, call download_video by default (use download_audio only if they ask for audio/mp3/music). You cannot send files yourself — only a tool call delivers them, so never reply with text claiming a video was sent. For anything else — greetings, questions, chat — reply directly with plain text; do NOT invent tools that are not in the list. Keep replies short — this is a chat app.`;

const URL_RE = /https?:\/\/\S+/i;

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
  return withSpan("llm.route", { "llm.model": config.llm.model }, async (span) => {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: userText },
    ];

    let msg = await chatCompletion(messages, true);

    if (msg.tool_calls?.length) {
      const call = msg.tool_calls[0];
      span.setAttribute("llm.tool_call", call.function.name);

      if (KNOWN_TOOLS.has(call.function.name)) {
        // OpenAI protocol sends arguments as a JSON string; some Ollama
        // versions send an object. Handle both.
        const rawArgs = call.function.arguments;
        const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
        logger.info({ tool: call.function.name }, "routed to tool");
        return { type: "tool", name: call.function.name, args, callId: call.id };
      }

      // The model hallucinated a tool that doesn't exist (small models do this
      // for plain chat, e.g. a made-up "respond" tool). Re-ask without tools
      // to force a plain-text reply.
      logger.warn({ tool: call.function.name }, "model hallucinated unknown tool; re-asking without tools");
      msg = await chatCompletion(messages, false);
    }

    // Links default to a video download. Small models sometimes answer a
    // link with text (e.g. mimicking "Sent video: ...") instead of calling
    // the tool, so force the download when the message contains a URL.
    const url = userText.match(URL_RE)?.[0];
    if (url) {
      logger.warn("model replied with text to a URL; forcing download_video");
      span.setAttribute("llm.tool_call", "download_video");
      return { type: "tool", name: "download_video", args: { url } };
    }

    return { type: "text", content: msg.content };
  });
}
