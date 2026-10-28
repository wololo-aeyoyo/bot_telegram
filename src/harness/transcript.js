// Raw turns of one chat, stored as JSON lines in chats/<chatId>/transcript.jsonl
// next to a rolling summary.md of what was folded away. A turn is one directed
// user message plus everything the bot did in answer, so it is never split.

import { speakerLabel } from "./identity.js";
import { KEEP_TOOL_RESULTS, MAX_FILE_BYTES, TOOL_RESULT_STORED_CHARS, truncate } from "./limits.js";

const bytesOf = (text) => Buffer.byteLength(text, "utf8");

// Entries after the first user entry belong to that turn; anything before it
// is an orphan (its turn was trimmed away) and is dropped.
export function groupTurns(entries) {
  const turns = [];
  for (const entry of entries) {
    if (entry.type === "user") turns.push([entry]);
    else if (turns.length > 0) turns.at(-1).push(entry);
  }
  return turns;
}

// A message that was only the trigger word ("Clanker") has no text left once
// the trigger is stripped; say so instead of handing the model an empty line.
const userText = (entry) => (entry.text?.trim() ? entry.text : "(no other text: they just called you)");

const userLabel = (entry, timezone) =>
  speakerLabel({ from: entry.from, replyTo: entry.replyTo, mentions: entry.mentions, date: new Date(entry.ts), timezone });

function renderEntry(entry, timezone) {
  if (entry.type === "user") {
    return { role: "user", content: `${userLabel(entry, timezone)}\n${userText(entry)}` };
  }
  if (entry.type === "assistant") {
    const message = { role: "assistant", content: entry.text ?? "" };
    if (entry.toolCalls?.length) {
      message.tool_calls = entry.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      }));
    }
    return message;
  }
  return { role: "tool", tool_call_id: entry.toolCallId, content: entry.text };
}

export function renderTurn(turn, { timezone }) {
  return turn.map((entry) => renderEntry(entry, timezone));
}

// Newest whole turns that fit in `maxChars`; `older` is everything before them.
export function selectRecent(turns, maxChars, { timezone }) {
  let used = 0;
  let start = turns.length;
  while (start > 0) {
    const size = JSON.stringify(renderTurn(turns[start - 1], { timezone })).length;
    if (used + size > maxChars) break;
    used += size;
    start -= 1;
  }
  return { recent: turns.slice(start), older: turns.slice(0, start) };
}

// Tool output is the bulkiest part of a turn and the least useful once the
// model has acted on it, so only the newest results stay in full.
export function renderHistory(turns, { timezone, keepToolResults = KEEP_TOOL_RESULTS }) {
  const messages = turns.flatMap((turn) => renderTurn(turn, { timezone }));
  const toolAt = [];
  messages.forEach((m, i) => {
    if (m.role === "tool") toolAt.push(i);
  });
  for (const i of toolAt.slice(0, Math.max(0, toolAt.length - keepToolResults))) {
    messages[i] = { ...messages[i], content: "[old tool result cleared]" };
  }
  return messages;
}

// Plain-text form of turns, for the summarizer prompt.
export function renderTurnsAsText(turns, { timezone }) {
  return turns
    .map((turn) =>
      turn
        .flatMap((entry) => {
          if (entry.type === "user") return [`${userLabel(entry, timezone)}\n${userText(entry)}`];
          // The summary is read back by the bot itself, so it is written to "you".
          if (entry.type === "assistant") {
            const lines = entry.text ? [`you: ${entry.text}`] : [];
            for (const c of entry.toolCalls ?? []) lines.push(`you called ${c.name}(${c.arguments})`);
            return lines;
          }
          return [`${entry.name} result: ${entry.text}`];
        })
        .join("\n"),
    )
    .join("\n\n");
}

// Loop output (assistant and tool messages) to transcript entries.
export function entriesFromMessages(added, now) {
  const ts = now.toISOString();
  const nameById = new Map();
  return added.flatMap((m) => {
    if (m.role === "assistant") {
      const entry = { type: "assistant", ts, text: m.content ?? "" };
      if (m.tool_calls?.length) {
        entry.toolCalls = m.tool_calls.map((c) => {
          nameById.set(c.id, c.function.name);
          return { id: c.id, name: c.function.name, arguments: c.function.arguments };
        });
      }
      return [entry];
    }
    if (m.role === "tool") {
      return [{ type: "tool", ts, toolCallId: m.tool_call_id, name: nameById.get(m.tool_call_id) ?? "unknown", text: m.content ?? "" }];
    }
    return [];
  });
}

const serialize = (entries) => (entries.length === 0 ? "" : `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);

// What goes to disk: tool output is cut short, and the text of a message that
// was not addressed to the bot is never kept ("directed messages only").
function prepareForStorage(entry) {
  if (entry.type === "tool") {
    const text = entry.text ?? "";
    const stored = truncate(text, TOOL_RESULT_STORED_CHARS, "Stored history keeps only the start.");
    // A cut data block would lose its closing marker; put it back so replayed
    // history never holds an unterminated ⟦data …⟧ block.
    const closing = text.match(/\n(⟦end [0-9a-f]+⟧)$/)?.[1];
    return { ...entry, text: closing && stored !== text ? `${stored}\n${closing}` : stored };
  }
  if (entry.type === "user" && entry.replyTo && !entry.replyTo.isBot) {
    return { ...entry, replyTo: { ...entry.replyTo, text: null } };
  }
  return entry;
}

export function createTranscript({ store, log }) {
  const pathsOf = (chatId) => {
    if (!Number.isSafeInteger(chatId)) throw new Error(`invalid chat id: ${chatId}`);
    return { transcript: `chats/${chatId}/transcript.jsonl`, summary: `chats/${chatId}/summary.md` };
  };

  // Raw lines grouped by turn, so whole turns can be dropped without re-serializing.
  function rawTurns(text, chatId) {
    const turns = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let type;
      try {
        type = JSON.parse(line).type;
      } catch (err) {
        log.warn({ err, chatId }, "unreadable transcript line while trimming");
      }
      if (type === "user") turns.push([line]);
      else if (turns.length > 0) turns.at(-1).push(line);
    }
    return turns;
  }

  async function load(chatId) {
    const paths = pathsOf(chatId);
    const [text, summary] = await Promise.all([store.readText(paths.transcript), store.readText(paths.summary)]);
    const entries = [];
    for (const line of (text ?? "").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const entry = JSON.parse(line);
        if (["user", "assistant", "tool"].includes(entry?.type)) entries.push(entry);
      } catch (err) {
        log.warn({ err, chatId }, "skipping unreadable transcript line");
      }
    }
    return { entries, summary: summary ?? "" };
  }

  async function appendTurn(chatId, entries) {
    const rel = pathsOf(chatId).transcript;
    const block = serialize(entries.map(prepareForStorage));
    await store.updateText(rel, (current) => {
      const existing = current ?? "";
      const joined = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
      if (bytesOf(joined + block) <= MAX_FILE_BYTES) return joined + block;

      // Over the cap: drop whole turns from the oldest until the new one fits.
      const turns = rawTurns(joined, chatId);
      const sizes = turns.map((t) => bytesOf(`${t.join("\n")}\n`));
      let total = sizes.reduce((a, b) => a + b, 0) + bytesOf(block);
      let dropped = 0;
      while (dropped < turns.length && total > MAX_FILE_BYTES) {
        total -= sizes[dropped];
        dropped += 1;
      }
      log.warn({ chatId, droppedTurns: dropped }, "transcript over the file cap; dropped the oldest turns");
      return turns.slice(dropped).map((t) => `${t.join("\n")}\n`).join("") + block;
    });
  }

  // The summary goes first: a crash between the two writes then repeats some
  // folded turns, where the opposite order would lose them.
  async function rewrite(chatId, entries, summary) {
    const paths = pathsOf(chatId);
    await store.updateText(paths.summary, () => summary, { backup: true });
    await store.updateText(paths.transcript, () => serialize(entries), { backup: true });
  }

  // Backups go too: a reset that leaves the old conversation in .prev forgets nothing.
  async function clear(chatId) {
    const paths = pathsOf(chatId);
    for (const rel of [paths.transcript, paths.summary]) {
      await store.remove(rel);
      await store.remove(`${rel}.prev`);
    }
  }

  return {
    load,
    appendTurn,
    rewrite,
    clear,
    byteSize: (chatId) => store.byteSize(pathsOf(chatId).transcript),
  };
}
