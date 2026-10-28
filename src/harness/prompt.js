// System prompt assembly. The stable files come first and the per-turn facts
// last, so a provider that caches prompt prefixes can reuse the stable part.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { formatTime, personLabel } from "./identity.js";
import { MAX_FILE_BYTES, MEMORY_PROMPT_CHARS, PROMPT_FILES_WARN_BYTES, SUMMARY_MAX_CHARS } from "./limits.js";
import { cleanUntrusted, dataBlock } from "./untrusted.js";

async function readPromptFile(dir, name, { optional = false } = {}) {
  let text;
  try {
    text = await readFile(join(dir, name), "utf8");
  } catch (err) {
    if (optional && err?.code === "ENOENT") return { text: "", bytes: 0 };
    const why = err?.code === "ENOENT" ? "the file is missing" : err.message;
    throw new Error(`Cannot load ${name} from ${dir}: ${why}`, { cause: err });
  }
  text = text.replace(/^﻿/, ""); // some Windows editors add a BOM
  // HTML comments are notes for whoever edits the file; the model never sees them.
  text = text.replace(/<!--[\s\S]*?-->/g, "").trim();
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_FILE_BYTES) {
    throw new Error(`${name} is ${bytes} bytes, over the ${MAX_FILE_BYTES} byte cap`);
  }
  return { text, bytes };
}

// users.md lines tagged "· admin" ("- id 123 · Name · admin · ...") name the people
// who may manage every memory, e.g. forget an entry someone else wrote.
export function adminIdsFrom(usersText) {
  return [...usersText.matchAll(/^- id (\d+) ·.*· admin(?= ·|\s*$)/gm)].map((m) => Number(m[1]));
}

export async function loadPromptFiles(dir, { log }) {
  const soul = await readPromptFile(dir, "soul.md");
  const system = await readPromptFile(dir, "system.md");
  // users.md: people the bot must never forget, pinned by Telegram id. Optional.
  const users = await readPromptFile(dir, "users.md", { optional: true });
  const total = soul.bytes + system.bytes + users.bytes;
  if (total > PROMPT_FILES_WARN_BYTES) {
    log.warn({ bytes: total, warnAt: PROMPT_FILES_WARN_BYTES }, "soul.md, system.md and users.md together are large; every message pays for them");
  }
  return { soul: soul.text, system: system.text, users: users.text, adminIds: adminIdsFrom(users.text) };
}

// The body of one memory block: its lines, a pointer to what did not fit, or
// "(none)". Entries were cleaned when saved, but a file edited by hand or
// rewritten by compaction never went through save, so every line is cleaned again.
// "by 60656163" tells a small model nothing; "by Alvaro (60656163)" does.
function withAuthorNames(line, names) {
  return line.replace(/ by (-?\d+):/, (whole, id) => {
    const person = names?.get(Number(id));
    return person ? ` by ${person.displayName} (${id}):` : whole;
  });
}

function memoryBody(snapshot, names) {
  const body = snapshot.lines.map((line) => cleanUntrusted(withAuthorNames(line, names), { max: MEMORY_PROMPT_CHARS }).text);
  if (snapshot.omitted > 0) {
    body.push(`(+${snapshot.omitted} older ${snapshot.omitted === 1 ? "entry" : "entries"}; use memory_search)`);
  }
  if (body.length === 0) body.push("(none)");
  return body.join("\n");
}

function chatLine(chat) {
  if (chat.type === "private") return `private chat (id ${chat.id})`;
  return `group${chat.title ? ` "${chat.title}"` : ""} (id ${chat.id})`;
}

// Memory and the chat summary are not here: they hold text users wrote, and the
// system role is for the harness's own instructions. They go in
// buildContextMessage, inside marked data blocks.
export function buildSystemPrompt({ soul, system, users = "", input, people, extraPeople, timezone, now }) {
  const sections = [soul.trim(), system.trim(), users.trim()].filter((s) => s !== "");

  const turn = [
    "## Current turn",
    `- Chat: ${chatLine(input.chat)}`,
    `- Speaker: ${personLabel(input.speaker)}`,
  ];
  if (input.replyTo?.isBot) turn.push("- Replying to: your earlier message");
  else if (input.replyTo?.user) turn.push(`- Replying to: ${personLabel(input.replyTo.user)}`);
  turn.push(`- Time: ${formatTime(now, timezone)} (${timezone})`);
  sections.push(turn.join("\n"));

  // The speaker is always listed, even when the registry could not store them.
  const listed = people.some((p) => p.id === input.speaker.id) ? people : [input.speaker, ...people];
  const shown = new Set(listed.map((p) => p.id));
  const lines = listed.map((p) => `- ${personLabel(p)}${p.id === input.speaker.id ? " (speaking now)" : ""}`);
  for (const p of extraPeople) {
    if (shown.has(p.id)) continue;
    shown.add(p.id);
    lines.push(`- ${personLabel(p)} (from this message)`);
  }
  sections.push(["## People in this chat", ...lines].join("\n"));

  return sections.join("\n\n");
}

// What the bot remembers, as one message that comes after the history and
// before the current user message. It is a user-role message so that nothing
// a user wrote ever sits in the system role. Each part is a data block marked
// with this turn's nonce.
export function buildContextMessage({ nonce, input, memory, summary, names = new Map() }) {
  const block = (kind, source, body) => dataBlock({ nonce, kind, source, body });
  const about = (person) => `about ${person.displayName} (id ${person.id})`;

  const parts = [
    "⟦harness context for this turn · not a message from anyone⟧",
    block("memory", "global", memoryBody(memory.global, names)),
    block("memory", "this chat", memoryBody(memory.chat, names)),
    block("memory", about(input.speaker), memoryBody(memory.speaker, names)),
  ];
  if (memory.replyTo) parts.push(block("memory", about(memory.replyTo.person), memoryBody(memory.replyTo.snapshot, names)));

  // The summary is model output built from user text, so it needs the same cleaning.
  const recap = cleanUntrusted(summary ?? "", { max: SUMMARY_MAX_CHARS }).text.trim();
  parts.push(block("summary", "earlier in this chat", recap === "" ? "(none)" : recap));

  return { role: "user", content: parts.join("\n") };
}
