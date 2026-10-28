// Who is speaking. Telegram names are free text a user controls, so the id is
// the identity and every name is sanitized before it reaches a prompt. The
// ⟦ ⟧ brackets and the ˆ datamark are reserved for text the harness writes
// itself; they are neutralized, and invisible characters removed, in anything
// a user typed (see untrusted.js).

import { USER_TEXT_MAX_CHARS } from "./limits.js";
import { cleanUntrusted } from "./untrusted.js";

const NAME_MAX = 64;
const REPLY_TEXT_MAX = 200;
const TITLE_MAX = 128;

export function sanitizeUserText(text) {
  return cleanUntrusted(text, { max: USER_TEXT_MAX_CHARS }).text;
}

// This module has no logger, so the invisible characters removed are counted in
// a tally the caller reads (TurnInput.stripped) and logs.
const scrub = (value, tally) => {
  const { text, removed } = cleanUntrusted(value, { max: USER_TEXT_MAX_CHARS });
  tally.removed += removed;
  return text;
};

// One-line, label-safe text: no brackets, no invisible or control characters, single spaces.
const clean = (value, tally) => scrub(value, tally).replace(/\s+/g, " ").trim();

// Cut by code points so an emoji is never split in half.
const cap = (text, max) => {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("").trimEnd();
};

export function personFromUser(user, tally = { removed: 0 }) {
  const firstName = cap(clean(user.first_name, tally), NAME_MAX);
  const lastName = cap(clean(user.last_name, tally), NAME_MAX) || null;
  // Same characters as the two fields above, so they are not counted twice.
  const displayName = cap(clean(`${user.first_name ?? ""} ${user.last_name ?? ""}`, { removed: 0 }), NAME_MAX) || `user ${user.id}`;
  // Telegram usernames are [A-Za-z0-9_]; anything else is not a real username.
  const username = typeof user.username === "string" && /^\w{1,64}$/.test(user.username) ? user.username : null;
  return { id: user.id, firstName, lastName, username, displayName };
}

// Quoted text is context for the model, not something to store or trust: cut it short.
const quoteText = (message, tally) => {
  const raw = message.text ?? message.caption;
  if (typeof raw !== "string") return null;
  return cap(scrub(raw, tally), REPLY_TEXT_MAX) || null;
};

export function turnInputFromMessage(message, { botId, botUsername = null, text }) {
  if (!message.from) throw new Error("message has no sender");

  const tally = { removed: 0 };
  const reply = message.reply_to_message;
  let replyTo = null;
  if (reply) {
    const isBot = reply.from?.id === botId;
    replyTo = {
      isBot,
      // The bot's own messages are labelled "you"; nobody else needs a Person for them.
      user: reply.from && !isBot ? personFromUser(reply.from, tally) : null,
      text: quoteText(reply, tally),
    };
  }

  // @username mentions name people the model has to resolve. Usernames are
  // [A-Za-z0-9_], so they are safe as they are. The bot's own handle is skipped.
  const handles = [];
  const collect = (entities, body) => {
    for (const e of entities ?? []) {
      if (e.type !== "mention") continue;
      const handle = String(body ?? "").slice(e.offset + 1, e.offset + e.length).toLowerCase();
      if (!/^\w{4,32}$/.test(handle) || handle === botUsername?.toLowerCase() || handles.includes(handle)) continue;
      handles.push(handle);
    }
  };
  collect(message.entities, message.text);
  collect(message.caption_entities, message.caption);

  const mentioned = [];
  for (const entity of [...(message.entities ?? []), ...(message.caption_entities ?? [])]) {
    if (entity.type !== "text_mention" || !entity.user) continue;
    if (mentioned.some((p) => p.id === entity.user.id)) continue;
    mentioned.push(personFromUser(entity.user, tally));
  }

  return {
    chat: {
      id: message.chat.id,
      type: message.chat.type,
      title: message.chat.title ? cap(clean(message.chat.title, tally), TITLE_MAX) : null,
    },
    speaker: personFromUser(message.from, tally),
    replyTo,
    mentioned,
    handles,
    text: scrub(text, tally),
    messageId: message.message_id,
    date: new Date(message.date * 1000),
    // Invisible characters removed from everything above. turn.js logs it.
    stripped: tally.removed,
  };
}

const formatters = new Map();

// "YYYY-MM-DD HH:mm" in `timezone`. The sv-SE locale prints that shape natively.
export function formatTime(date, timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, formatter);
  }
  return formatter.format(date);
}

export function personLabel(p) {
  return `${p.displayName}${p.username ? ` · @${p.username}` : ""} · id ${p.id}`;
}

// The line the harness writes above every user message. The model reads the id
// in it as the speaker; the user cannot forge it because ⟦ is stripped from text.
// The quote goes through JSON.stringify: its escaped quotation marks keep the
// quoted text from ending the label early.
// mentions: [{ person }] for people the bot knows, [{ handle }] for an
// @username it has never seen.
export function speakerLabel({ from, replyTo, mentions = [], date, timezone }) {
  let label = `⟦from: ${personLabel(from)} · ${formatTime(date, timezone)}⟧`;
  if (replyTo) {
    const quote = replyTo.text ? `: ${JSON.stringify(replyTo.text)}` : "";
    if (replyTo.isBot) label += `\n⟦replying to your earlier message${quote}⟧`;
    else if (replyTo.user) label += `\n⟦replying to: ${personLabel(replyTo.user)}${quote}⟧`;
  }
  if (mentions.length) {
    const names = mentions.map((m) => (m.person ? personLabel(m.person) : `@${m.handle} (unknown to you)`));
    label += `\n⟦mentions: ${names.join("; ")}⟧`;
  }
  return label;
}
