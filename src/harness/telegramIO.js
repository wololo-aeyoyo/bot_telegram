// Everything the harness does to Telegram for one incoming message: deliver
// media tool results, answer the telegram_info tool, check membership and send
// the final reply. Kept apart from the turn logic so that logic never touches
// the Telegram client directly.

import { personFromUser } from "./identity.js";

const TYPING_EVERY_MS = 4_000; // the status fades after about 5 seconds

// creator | administrator | member are in the chat; a restricted user is in it
// only while is_member is true; left and kicked are out.
export function isPresentStatus(member) {
  switch (member.status) {
    case "creator":
    case "administrator":
    case "member":
      return true;
    case "restricted":
      return member.is_member === true;
    default:
      return false;
  }
}

export function createTelegramIO({ ctx, dispatch, log }) {
  const chatId = ctx.chat.id;

  // Cleaning up the "Working on it..." message must never hide the real outcome.
  async function bestEffort(action, what) {
    try {
      await action();
    } catch (err) {
      log.warn({ err }, `could not ${what}`);
    }
  }

  // Run the tool and put its result in front of the user. The string returned
  // is what the model sees: it never contains file bytes.
  async function deliverTool(name, args) {
    const placeholder = await ctx.reply("Working on it...");
    let removed = false;
    const removePlaceholder = async () => {
      if (removed) return;
      removed = true;
      await bestEffort(() => ctx.telegram.deleteMessage(chatId, placeholder.message_id), "delete the placeholder message");
    };
    try {
      const result = await dispatch(name, args);

      // A miss ("nothing found") goes only to the model, so it can retry or
      // explain in one reply instead of every failed attempt landing in the chat.
      if (result.type === "miss") {
        await removePlaceholder();
        return `Nothing was sent to the chat: ${result.text}`;
      }

      if (result.type === "media") {
        await removePlaceholder();
        await ctx.replyWithMediaGroup(result.media);
        return result.fallbackText;
      }

      if (result.type === "video") {
        await bestEffort(
          () => ctx.telegram.editMessageText(chatId, placeholder.message_id, undefined, "Uploading to Telegram..."),
          "edit the placeholder message",
        );
        const file = { source: result.buffer, filename: result.filename };
        if (result.mimeType.startsWith("video/")) {
          await ctx.replyWithVideo(file, { caption: result.filename });
        } else {
          await ctx.replyWithDocument(file, { caption: result.filename });
        }
        await removePlaceholder();
        return result.fallbackText;
      }

      try {
        await ctx.telegram.editMessageText(chatId, placeholder.message_id, undefined, result.text);
      } catch (err) {
        // The edit is the delivery here, so a failed edit falls back to a fresh
        // message instead of telling the model something reached the chat that didn't.
        log.warn({ err }, "could not edit the placeholder message; sending the result as a new message");
        await ctx.reply(result.text);
        await removePlaceholder();
      }
      return `Delivered to the user: ${result.text}`;
    } catch (err) {
      // The failure goes back to the model as a tool error; don't leave a stale placeholder behind.
      await removePlaceholder();
      throw err;
    }
  }

  const memberInfo = (m) => ({
    user_id: m.user.id,
    name: personFromUser(m.user).displayName,
    status: m.status,
    custom_title: m.custom_title ?? null,
  });

  const telegramInfo = {
    async chat() {
      const [chat, memberCount] = await Promise.all([ctx.telegram.getChat(chatId), ctx.telegram.getChatMembersCount(chatId)]);
      return {
        id: chat.id,
        type: chat.type,
        title: chat.title ?? null,
        description: chat.description ?? null,
        member_count: memberCount,
      };
    },
    async member(userId) {
      return memberInfo(await ctx.telegram.getChatMember(chatId, userId));
    },
    async admins() {
      return (await ctx.telegram.getChatAdministrators(chatId)).map(memberInfo);
    },
  };

  async function isMember(userId) {
    try {
      return isPresentStatus(await ctx.telegram.getChatMember(chatId, userId));
    } catch (err) {
      log.warn({ err, userId }, "could not check chat membership; treating as not a member");
      return false;
    }
  }

  // The person behind an id, if they are in this chat right now. Lets the bot
  // mention a member who never wrote to it (and so isn't in people.json).
  async function memberPerson(userId) {
    try {
      const member = await ctx.telegram.getChatMember(chatId, userId);
      return isPresentStatus(member) ? personFromUser(member.user) : null;
    } catch (err) {
      log.warn({ err, userId }, "could not look up a chat member; the mention will be dropped");
      return null;
    }
  }

  // Entities carry the mentions, so no parse_mode is needed.
  async function send(chunk) {
    await ctx.reply(chunk.text, chunk.entities.length ? { entities: chunk.entities } : undefined);
  }

  // Telegram's "typing…" status lasts about 5 seconds (Bot API sendChatAction), so
  // it is renewed while the agent works. Works in groups, where message drafts
  // don't. Returns a function that stops it; calling it twice is fine.
  function startTyping() {
    let warned = false;
    const ping = () =>
      ctx.telegram.sendChatAction(chatId, "typing").catch((err) => {
        if (warned) return;
        warned = true;
        log.warn({ err }, "could not send the typing status");
      });
    ping();
    const timer = setInterval(ping, TYPING_EVERY_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { deliverTool, telegramInfo, isMember, memberPerson, send, startTyping };
}
