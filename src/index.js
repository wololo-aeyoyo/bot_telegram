import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { TOOLS, dispatch } from "./tools/index.js";
import { logger } from "./logger.js";
import { withSpan } from "./tracing.js";
import { createStore } from "./harness/store.js";
import { createMemory } from "./harness/memory.js";
import { createPeople } from "./harness/people.js";
import { createTranscript } from "./harness/transcript.js";
import { createChatCompletion } from "./harness/llm.js";
import { loadPromptFiles } from "./harness/prompt.js";
import { createAgent } from "./harness/turn.js";
import { createTelegramIO } from "./harness/telegramIO.js";
import { turnInputFromMessage } from "./harness/identity.js";

// The agent's identity and rules live in files the owner edits. If they are
// missing or too big, stop here: a bot with no prompt would answer as nobody.
let prompts;
try {
  prompts = await loadPromptFiles(config.agent.promptDir, { log: logger });
} catch (err) {
  logger.fatal({ err, promptDir: config.agent.promptDir }, "cannot load the agent prompt files");
  process.exit(1);
}

const store = createStore({ root: config.agent.dataDir, log: logger });
const agent = createAgent({
  store,
  memory: createMemory({ store, log: logger }),
  people: createPeople({ store }),
  transcript: createTranscript({ store, log: logger }),
  complete: createChatCompletion(config.llm),
  mediaTools: TOOLS,
  prompts,
  timezone: config.agent.timezone,
  maxLlmCalls: config.agent.maxLlmCalls,
  maxReplyChars: config.agent.maxReplyChars,
  log: logger,
});

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

// Clears this chat's transcript and summary. Long-term memory stays.
// Shows the sender's Telegram id (and the chat's) so the owner can pin people in
// agent/users.md without digging through logs. Sent as a reply, it also shows
// the id of the author of the replied-to message.
bot.command("id", (ctx) => {
  const who = (u) => `${u.id}${u.username ? ` (@${u.username})` : ""}`;
  const lines = [`Tu id: ${who(ctx.from)}`];
  const author = ctx.message.reply_to_message?.from;
  if (author) lines.push(`Id de ${author.first_name ?? "esa persona"}: ${who(author)}`);
  lines.push(`Id de este chat: ${ctx.chat.id}`);
  return ctx.reply(lines.join("\n"));
});

bot.command("reset", async (ctx) => {
  try {
    await agent.reset(ctx.chat.id);
    await ctx.reply("Conversation history cleared.");
  } catch (err) {
    logger.error({ err, chatId: ctx.chat.id }, "reset failed");
    await replyQuietly(ctx, "Sorry, I couldn't clear the history. 😕", logger);
  }
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

// A message is directed at the bot when it opens with a trigger word, starts
// with /clanker (or /clanker@ThisBot), @-mentions the bot anywhere, or replies
// to one of the bot's own messages. Returns the text to hand the agent, with
// the trigger removed, or null to stay silent.
function directedText(ctx) {
  const { text, entities = [], reply_to_message: replyTo } = ctx.message;
  const username = ctx.botInfo?.username?.toLowerCase();

  const prefixed = matchTrigger(text);
  if (prefixed !== null) return prefixed;

  const command = text.match(/^\/clanker(?:@(\w+))?(?=\s|$)/i);
  if (command && (!command[1] || command[1].toLowerCase() === username)) {
    return text.slice(command[0].length).trim();
  }

  const mention = entities.find(
    (e) => e.type === "mention" && text.slice(e.offset + 1, e.offset + e.length).toLowerCase() === username
  );
  if (mention) {
    return (text.slice(0, mention.offset) + text.slice(mention.offset + mention.length)).replace(/\s+/g, " ").trim();
  }

  if (replyTo?.from?.id === ctx.botInfo?.id) return text;
  return null;
}

// What the group sees when a turn fails. It is also stored as the bot's own
// reply, so a later "wtf?" reads as a reply to the bot.
const FAILURE_NOTICE = "Algo falló de mi lado con eso. Inténtalo otra vez.";

// The error message is a courtesy: if it can't be sent, log and move on.
async function replyQuietly(ctx, text, log) {
  try {
    await ctx.reply(text);
  } catch (err) {
    log.warn({ err }, "could not send the error message");
  }
}

bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;

  // Everything not directed at the bot is ignored, so it stays quiet in a busy
  // friend group and stores nothing about it.
  const userText = directedText(ctx);
  if (userText === null) return;

  // Root span for the whole update — child spans (LLM call, tool dispatch,
  // outbound http) nest under it, and the trace id lands on every log line.
  await withSpan(
    "telegram.message",
    { "chat.id": chatId, "chat.type": ctx.chat.type, "user.id": ctx.from.id },
    async () => {
      const log = logger.child({ chatId, userId: ctx.from.id });
      log.info({ len: userText.length }, "handling message");

      let input = null;
      try {
        input = turnInputFromMessage(ctx.message, { botId: ctx.botInfo.id, botUsername: ctx.botInfo.username, text: userText });
        await agent.handleTurn(input, createTelegramIO({ ctx, dispatch, log }));
      } catch (err) {
        log.error({ err }, "handler failed");
        await replyQuietly(ctx, FAILURE_NOTICE, log);
        // So the bot later knows it sent that notice itself.
        if (input) await agent.recordFailure(input, FAILURE_NOTICE).catch((recordErr) => log.warn({ err: recordErr }, "could not record the failed turn"));
      }
    }
  );
});

// Without this a rejected handler, such as a Telegraf handlerTimeout, escapes
// as an unhandled rejection and takes the process down.
bot.catch((err, ctx) => logger.error({ err, updateId: ctx.update?.update_id }, "update handler failed"));

bot.launch(() => {
  logger.info(
    { username: bot.botInfo?.username, model: config.llm.model, llmBaseUrl: config.llm.baseUrl },
    "bot started"
  );
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
