// Keeps the two growing stores bounded. A transcript over the threshold folds
// its oldest turns into a summary; a memory partition over the threshold has
// near-duplicate entries merged. Both run after the reply is sent, call the LLM
// without tools, and leave the data untouched when the answer looks wrong.

import {
  HISTORY_PROMPT_CHARS,
  MAX_MEMORY_ENTRY_CHARS,
  MEMORY_COMPACT_BYTES,
  SUMMARY_MAX_CHARS,
  TRANSCRIPT_COMPACT_BYTES,
} from "./limits.js";
import { formatEntry } from "./memory.js";
import { groupTurns, renderTurnsAsText, selectRecent } from "./transcript.js";

export const SUMMARY_PROMPT = [
  "You maintain the running memory of a Telegram chat between a bot and one or more people.",
  "You get the previous summary and a batch of older turns. Write an updated summary that merges both.",
  "The bot will read this summary later, so refer to the bot as \"you\" (\"you told Alvaro…\"), never by name or in the third person.",
  "",
  "Capture everything a later turn could need:",
  "- People: who said what, by name and id. Keep ids exactly as written.",
  "- Facts and decisions: preferences, plans, answers the bot gave.",
  "- Open threads: unanswered questions, promises the bot made, messages someone asked the bot to pass on.",
  "- Media: what the bot downloaded or sent, with titles and links.",
  "",
  "Drop greetings and chatter. Keep it under 6000 characters. Write in the language the chat uses.",
  "Do not call any tools while writing this summary; respond with text only.",
  "Wrap your summary in <summary></summary> tags.",
].join("\n");

export const MEMORY_COMPACT_PROMPT = [
  'You clean up a list of long-term memory entries. Each line is "[id] text". Lines are ordered oldest to newest.',
  "Merge duplicates and entries that say the same thing. When a newer entry contradicts an older one, keep the newer one.",
  "Keep every distinct fact. Never invent facts.",
  'Output only lines in the same "[id] text" format. When you merge entries, keep the id of the newest one.',
  "Do not call any tools; respond with text only.",
].join("\n");

// The text between <summary> tags, or the whole reply when the model left them out.
function extractSummary(content) {
  const tagged = /<summary>([\s\S]*?)<\/summary>/i.exec(content);
  if (tagged) return tagged[1].trim();
  return content.replace(/<\/?summary>/gi, "").trim();
}

// The caller holds the chat lock, so nothing appends between the load and the rewrite.
export async function compactTranscript({ chatId, transcript, complete, timezone, log }) {
  const beforeBytes = await transcript.byteSize(chatId);
  if (beforeBytes <= TRANSCRIPT_COMPACT_BYTES) return false;

  const { entries, summary } = await transcript.load(chatId);
  const { recent, older } = selectRecent(groupTurns(entries), HISTORY_PROMPT_CHARS, { timezone });
  if (older.length === 0) return false;

  let reply;
  try {
    reply = await complete(
      [
        { role: "system", content: SUMMARY_PROMPT },
        {
          role: "user",
          content: `<previous_summary>\n${summary}\n</previous_summary>\n<turns>\n${renderTurnsAsText(older, { timezone })}\n</turns>`,
        },
      ],
      {},
    );
  } catch (err) {
    log.warn({ err, chatId }, "transcript compaction failed; transcript left as is");
    return false;
  }

  // A reply cut by the length limit reads like a finished summary but is missing its tail.
  if (reply.finishReason !== "stop") {
    log.warn({ chatId, finishReason: reply.finishReason }, "summary was cut off; transcript left as is");
    return false;
  }
  let text = extractSummary(reply.message.content ?? "");
  if (text === "") {
    log.warn({ chatId }, "summary came back empty; transcript left as is");
    return false;
  }
  if (text.length > SUMMARY_MAX_CHARS) {
    log.warn({ chatId, chars: text.length }, "summary over the limit; cutting it");
    text = text.slice(0, SUMMARY_MAX_CHARS);
  }

  await transcript.rewrite(chatId, recent.flat(), text);
  const afterBytes = await transcript.byteSize(chatId);
  log.info({ chatId, beforeBytes, afterBytes, foldedTurns: older.length }, "transcript compacted");
  return true;
}

const weight = (entries) => Buffer.byteLength(entries.map(formatEntry).join("\n"), "utf8");

export async function compactMemory({ memory, partition, complete, log }) {
  const beforeBytes = await memory.byteSize(partition);
  if (beforeBytes <= MEMORY_COMPACT_BYTES) return false;

  const snapshot = await memory.readEntries(partition);
  const byId = new Map(snapshot.map((e) => [e.id, e]));

  // Merge only inside one origin, so a private fact never ends up in a group entry.
  const groups = new Map();
  for (const entry of snapshot) {
    const key = `${entry.origin.kind}:${entry.origin.chatId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  // Ask the model to merge one group; returns id -> text for the entries it
  // keeps, or null when the answer fails a check (the group then stays as is).
  async function mergeGroup(origin, group) {
    const reject = (reason, extra) => {
      log.warn({ partition, origin, ...extra }, `memory compaction rejected: ${reason}`);
      return null;
    };
    let reply;
    try {
      reply = await complete(
        [
          { role: "system", content: MEMORY_COMPACT_PROMPT },
          { role: "user", content: group.map((e) => `[${e.id}] ${e.text}`).join("\n") },
        ],
        {},
      );
    } catch (err) {
      return reject("the call failed", { err });
    }
    // A reply cut by the length limit looks like a valid merge that dropped the tail.
    if (reply.finishReason !== "stop") return reject("reply was cut off", { finishReason: reply.finishReason });

    const inGroup = new Set(group.map((e) => e.id));
    const kept = new Map();
    for (const line of (reply.message.content ?? "").split("\n")) {
      if (line.trim() === "") continue;
      const match = /^\[([^\]]+)\] (.+)$/.exec(line.trimEnd());
      if (!match) return reject("line is not in [id] text format", { line });
      const [, id, rawText] = match;
      const text = rawText.trim();
      if (!inGroup.has(id)) return reject("unknown id", { id });
      if (kept.has(id)) return reject("repeated id", { id });
      if (text === "" || text.length > MAX_MEMORY_ENTRY_CHARS) return reject("entry text is empty or too long", { id });
      kept.set(id, text);
    }
    // An honest dedupe never removes more than half of what it was given.
    if (kept.size * 2 < group.length) return reject("too many entries dropped", { kept: kept.size, of: group.length });
    return kept;
  }

  const merged = new Map(); // id -> merged text, for entries that survive a valid merge
  const handled = new Set(); // ids of groups whose merge was accepted
  for (const [origin, group] of groups) {
    if (group.length < 2) continue;
    const kept = await mergeGroup(origin, group);
    if (!kept) continue;
    for (const entry of group) handled.add(entry.id);
    for (const [id, text] of kept) merged.set(id, text);
  }
  if (handled.size === 0) return false;

  // Another chat can save to this partition while the model answers, so the
  // result is applied to what the file holds now, under the file lock.
  let droppedEntries = 0;
  let changed = false;
  await memory.updateEntries(partition, (current) => {
    const next = [];
    for (const entry of current) {
      if (!handled.has(entry.id)) next.push(entry); // saved during the wait, or in a group left as is
      else if (merged.has(entry.id)) next.push({ ...byId.get(entry.id), text: merged.get(entry.id) });
      // else: merged away. An entry forgotten during the wait is not in `current`, so it stays gone.
    }
    if (weight(next) >= weight(current)) return current;
    droppedEntries = current.length - next.length;
    changed = true;
    return next;
  });
  if (!changed) return false;

  const afterBytes = await memory.byteSize(partition);
  log.info({ partition, beforeBytes, afterBytes, droppedEntries }, "memory compacted");
  return true;
}
