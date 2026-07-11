import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { routeMessage } from "./router.js";
import { dispatch } from "./tools/index.js";
import { getHistory, appendToHistory, clearHistory } from "./session.js";
import { logger } from "./logger.js";
import { withSpan } from "./tracing.js";

// Telegraf aborts handlers after 90s by default, and that timeout rejects
// outside our try/catch — an unhandled rejection that crashes the process.
// Downloads regularly exceed 90s, so give handlers 10 minutes.
const bot = new Telegraf(config.telegram.botToken, { handlerTimeout: 10 * 60 * 1000 });

// Whitelist check before anything else — silently ignore strangers. Access is
// gated by context, not by user alone:
//   - private chat: allowed only if the sender is in allowedUserIds
//   - group chat:   allowed only if the group is in allowedChatIds (any member
//                   may use it, but only inside that group)
// This means a whitelisted user can't drag the bot into some other random
// group and use it there.
bot.use((ctx, next) => {
  const isPrivate = ctx.chat?.type === "private";
  const allowed = isPrivate
    ? ctx.from && config.telegram.allowedUserIds.includes(ctx.from.id)
    : config.telegram.allowedChatIds.includes(ctx.chat?.id);
  if (!allowed) {
    logger.warn(
      { userId: ctx.from?.id, chatId: ctx.chat?.id, chatType: ctx.chat?.type },
      "ignored message from unauthorized chat/user"
    );
    return;
  }
  return next();
});

bot.command("start", (ctx) =>
  ctx.reply(
    "Hi! I can download videos/audio, add songs to Spotify, search images, or just chat. Send me a link or a request."
  )
);

bot.command("reset", (ctx) => {
  clearHistory(ctx.chat.id);
  return ctx.reply("Conversation history cleared.");
});

// The bot only reacts when a message opens with a trigger word. Returns the
// message stripped of the prefix, or null if the bot should stay silent.
function matchTrigger(text) {
  const trimmed = text.trimStart();
  const lower = trimmed.toLowerCase();
  for (const prefix of config.telegram.triggerPrefixes) {
    if (!lower.startsWith(prefix)) continue;
    // Require the prefix to be a whole word: end of message, or followed by
    // a space or punctuation ("bot", "bot,", "bot: hi") — not "botanist".
    const after = trimmed.slice(prefix.length);
    if (after === "" || /^[\s,.:!?]/.test(after)) {
      return after.replace(/^[\s,.:!?]+/, "").trimStart();
    }
  }
  return null;
}

bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;

  // Only process messages that open with a trigger word; ignore everything
  // else so the bot stays quiet in a busy friend group.
  const userText = matchTrigger(ctx.message.text);
  if (userText === null) return;

  // Root span for the whole update — child spans (LLM call, tool dispatch,
  // outbound http) nest under it, and the trace id lands on every log line.
  await withSpan(
    "telegram.message",
    { "chat.id": chatId, "chat.type": ctx.chat.type, "user.id": ctx.from.id },
    async (span) => {
      const log = logger.child({ chatId, userId: ctx.from.id });
      log.info({ len: userText.length }, "handling message");
      let placeholder = null;

      try {
        const route = await routeMessage(userText, getHistory(chatId));
        appendToHistory(chatId, { role: "user", content: userText });
        span.setAttribute("route.type", route.type);
        if (route.name) span.setAttribute("route.tool", route.name);

        if (route.type === "text") {
          appendToHistory(chatId, { role: "assistant", content: route.content });
          await ctx.reply(route.content);
          log.info("replied with text");
          return;
        }

        // Tool route: downloads can take 10-30+ seconds, so show progress
        // immediately and edit the message in place when done.
        placeholder = await ctx.reply("Working on it...");
        const result = await dispatch(route.name, route.args);

        if (result.type === "media") {
          await ctx.telegram.deleteMessage(chatId, placeholder.message_id).catch(() => {});
          await ctx.replyWithMediaGroup(result.media);
          appendToHistory(chatId, { role: "assistant", content: result.fallbackText });
        } else if (result.type === "video") {
          await ctx.telegram
            .editMessageText(chatId, placeholder.message_id, undefined, "Uploading to Telegram...")
            .catch(() => {});
          const file = { source: result.buffer, filename: result.filename };
          if (result.mimeType.startsWith("video/")) {
            await ctx.replyWithVideo(file, { caption: result.filename });
          } else {
            await ctx.replyWithDocument(file, { caption: result.filename });
          }
          await ctx.telegram.deleteMessage(chatId, placeholder.message_id).catch(() => {});
          appendToHistory(chatId, { role: "assistant", content: result.fallbackText });
        } else {
          await ctx.telegram.editMessageText(chatId, placeholder.message_id, undefined, result.text);
          appendToHistory(chatId, { role: "assistant", content: result.text });
        }
        log.info({ tool: route.name, resultType: result.type }, "tool completed");
      } catch (err) {
        log.error({ err }, "handler failed");
        const friendly = "Sorry, something went wrong with that request. 😕";
        if (placeholder) {
          await ctx.telegram
            .editMessageText(chatId, placeholder.message_id, undefined, friendly)
            .catch(() => {});
        } else {
          await ctx.reply(friendly).catch(() => {});
        }
      }
    }
  );
});

bot.launch(() => {
  logger.info(
    { username: bot.botInfo?.username, model: config.llm.model, llmBaseUrl: config.llm.baseUrl },
    "bot started"
  );
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
