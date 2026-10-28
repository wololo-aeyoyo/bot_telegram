// One directed message from start to finish: who is talking, what the bot
// remembers, the tool loop, the reply with mentions, and the housekeeping that
// follows. Everything runs under the chat's lock, so two messages in the same
// chat never interleave; chats do not wait for each other.

import { AGENT_TOOLS, createAgentToolExecutor } from "./agentTools.js";
import { REPLY_RULES, TOOL_COMMENT_RULES, checkReply, createCommentLog, recentForTics } from "./comments.js";
import { compactMemory, compactTranscript } from "./compaction.js";
import {
  HISTORY_PROMPT_CHARS,
  MEMORY_COMPACT_BYTES,
  MEMORY_COMPACT_RETRY_BYTES,
  MEMORY_PROMPT_CHARS,
  TOOL_RESULT_BODY_CHARS,
  TRANSCRIPT_COMPACT_BYTES,
} from "./limits.js";
import { runLoop } from "./loop.js";
import { buildContextMessage, buildSystemPrompt } from "./prompt.js";
import { mentionIds, polishReply, renderReply } from "./reply.js";
import { FileCapError } from "./store.js";
import { checkMediaUrl } from "./toolGuards.js";
import { entriesFromMessages, groupTurns, renderHistory, renderTurn, selectRecent } from "./transcript.js";
import { cleanUntrusted, dataBlock, newNonce } from "./untrusted.js";

export const URL_RE = /https?:\/\/\S+/i;

const GLOBAL = { kind: "global" };

// The media tools that fetch a URL the model chose.
const URL_TOOLS = new Set(["download_video", "download_audio"]);

// Lets the model post a message right away, before its final reply, so it can
// answer in several separate Telegram messages. Capped per turn so a confused
// model can't flood the chat.
const MAX_SENT_MESSAGES = 5;
// Extra model calls allowed to replace a reply the harness rejected as too long
// or too repetitive. They come out of the same per-message call budget.
const MAX_REPLY_RETRIES = 2;
// Words that show a retry is answering the harness note, not the person.
const META_RE = /(rechaz|reescrib|nueva versi[oó]n|otra versi[oó]n|m[aá]s cort[oa]|harness|caracteres|rejected|rewrit)/i;
const SEND_MESSAGE_TOOL = {
  type: "function",
  function: {
    name: "send_message",
    description:
      'Post one message to this chat right now, before your final reply. Use it only when the person asks for several separate messages, or to say something before a slow step. Each call is one Telegram message, and [[mention:ID]] works inside it. You may call it several times in one step. At most 5 per turn. Example: {"text":"1"}.',
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The message, plain text." } },
      required: ["text"],
    },
  },
};

export function createAgent({
  store,
  memory,
  people,
  transcript,
  complete,
  mediaTools,
  prompts: { soul, system, users = "", adminIds = [] },
  timezone,
  maxLlmCalls,
  maxReplyChars = 280,
  now = () => new Date(),
  log,
}) {
  const mediaNames = new Set(mediaTools.map((t) => t.function.name));
  const tools = [...mediaTools, ...AGENT_TOOLS, SEND_MESSAGE_TOOL];
  const comments = createCommentLog({ store });
  const toolNames = tools.map((t) => t.function.name);
  // Partitions whose last compaction did not shrink them, with the size they had
  // then. Without this a partition the model cannot shrink would cost a large
  // LLM call after every single memory_save.
  const stuckAt = new Map();
  // Same brake for transcripts, keyed by chat id: the size a transcript had when
  // its last compaction left it above the threshold.
  const transcriptStuckAt = new Map();

  // Only people who send a directed message enter the registry. A full registry
  // must not leave the bot silent, so that one error is logged and skipped.
  async function registerSpeaker(input) {
    try {
      await people.upsert(input.speaker, input.chat.id);
    } catch (err) {
      if (!(err instanceof FileCapError)) throw err;
      log.warn({ err, chatId: input.chat.id }, "people.json is full; the speaker is not registered");
    }
  }

  // Who the prompt lists: everyone known in this group, or only the speaker in private.
  async function peopleFor(input) {
    if (input.chat.type !== "private") return people.inChat(input.chat.id);
    const record = await people.get(input.speaker.id);
    return record ? [record] : [];
  }

  async function memorySnapshots(input) {
    const chatId = input.chat.id;
    // The snapshot itself drops entries that were written in other private chats.
    const snap = (partition) => memory.snapshot({ partition, chatId, maxChars: MEMORY_PROMPT_CHARS });
    const snapshots = {
      global: await snap(GLOBAL),
      chat: await snap({ kind: "chat", id: chatId }),
      speaker: await snap({ kind: "user", id: input.speaker.id }),
    };
    const other = input.replyTo?.user;
    if (other && other.id !== input.speaker.id) {
      snapshots.replyTo = { person: other, snapshot: await snap({ kind: "user", id: other.id }) };
    }
    return snapshots;
  }

  // Mention only people the chat can actually reach: the speaker in private,
  // current members in a group. Everyone else renders as a plain name.
  // The stored user message. @username mentions are resolved against the people
  // the bot knows here, so the label says who "@Wololo_aeyoyo" is instead of
  // leaving a small model to guess. replyTo.text goes in full; it is cut when
  // the turn is written to disk.
  function userEntryFor(input, candidates) {
    const byHandle = new Map(candidates.filter((p) => p.username).map((p) => [p.username.toLowerCase(), p]));
    const mentions = [
      ...input.mentioned.map((person) => ({ person })),
      ...(input.handles ?? []).map((handle) => (byHandle.has(handle) ? { person: byHandle.get(handle) } : { handle })),
    ].filter((m, i, all) => !m.person || all.findIndex((n) => n.person?.id === m.person.id) === i);
    return {
      type: "user",
      ts: input.date.toISOString(),
      messageId: input.messageId,
      from: input.speaker,
      replyTo: input.replyTo,
      ...(mentions.length ? { mentions } : {}),
      text: input.text,
    };
  }

  async function mentionableIds(text, input, known, io) {
    const mentionable = new Set();
    const isPrivate = input.chat.type === "private";
    for (const id of mentionIds(text)) {
      if (!known.has(id)) continue; // renderReply drops unknown ids, so asking Telegram would be wasted
      if (isPrivate ? id === input.chat.id : await io.isMember(id)) mentionable.add(id);
    }
    return mentionable;
  }

  async function compactPartition(key) {
    const partition = JSON.parse(key);
    const size = await memory.byteSize(partition);
    if (size <= MEMORY_COMPACT_BYTES) {
      stuckAt.delete(key);
      return;
    }
    const stuck = stuckAt.get(key);
    if (stuck !== undefined && size < stuck + MEMORY_COMPACT_RETRY_BYTES) return;
    if (await compactMemory({ memory, partition, complete, log })) stuckAt.delete(key);
    else stuckAt.set(key, await memory.byteSize(partition));
  }

  async function compactChatTranscript(chatId) {
    const size = await transcript.byteSize(chatId);
    if (size <= TRANSCRIPT_COMPACT_BYTES) {
      transcriptStuckAt.delete(chatId);
      return;
    }
    const stuck = transcriptStuckAt.get(chatId);
    if (stuck !== undefined && size < stuck + MEMORY_COMPACT_RETRY_BYTES) return;
    if (await compactTranscript({ chatId, transcript, complete, timezone, log })) transcriptStuckAt.delete(chatId);
    else transcriptStuckAt.set(chatId, await transcript.byteSize(chatId));
  }

  // Runs after the reply is out, so a slow summary never delays the answer.
  // Failures are only logged: the data is still valid, just bigger than wanted.
  async function compactAfterReply(chatId, touched) {
    try {
      await compactChatTranscript(chatId);
    } catch (err) {
      log.warn({ err, chatId }, "transcript compaction failed");
    }
    for (const key of touched) {
      try {
        await compactPartition(key);
      } catch (err) {
        log.warn({ err, chatId, partition: key }, "memory compaction failed");
      }
    }
  }

  async function runTurn(input, io) {
    const chatId = input.chat.id;
    const isPrivate = input.chat.type === "private";

    if (input.stripped > 0) log.info({ chatId, field: "message", removed: input.stripped }, "stripped invisible characters");

    await registerSpeaker(input);

    const { entries, summary } = await transcript.load(chatId);
    const { recent } = selectRecent(groupTurns(entries), HISTORY_PROMPT_CHARS, { timezone });
    const snapshots = await memorySnapshots(input);

    const listed = await peopleFor(input);
    const listedIds = new Set(listed.map((p) => p.id));
    listedIds.add(input.speaker.id);
    const extraPeople = [input.replyTo?.user, ...input.mentioned].filter(
      (p, i, all) => p && !listedIds.has(p.id) && all.findIndex((q) => q?.id === p.id) === i,
    );
    const known = new Map([...extraPeople, ...listed, input.speaker].map((p) => [p.id, p]));

    const userEntry = userEntryFor(input, [...known.values()]);
    // One nonce per turn marks every data block of this turn. The model sees it
    // only inside the prompt, which the people who write the data cannot read.
    const nonce = newNonce();
    // Order: instructions, history, data, then the current message. The user's
    // message goes last so the instructions come after the data (ANTH).
    const messages = [
      {
        role: "system",
        content: buildSystemPrompt({ soul, system, users, input, people: listed, extraPeople, timezone, now: now() }),
      },
      // Oldest first: memory and the summary of earlier turns, then the recent
      // turns, then the new message last, right where the model answers.
      buildContextMessage({ nonce, input, memory: snapshots, summary, names: known }),
      ...renderHistory(recent, { timezone }),
      ...renderTurn([userEntry], { timezone }),
    ];

    const agentTools = createAgentToolExecutor({
      memory,
      people,
      telegramInfo: io.telegramInfo,
      turn: { chatId, speakerId: input.speaker.id, isAdmin: adminIds.includes(input.speaker.id), origin: { kind: isPrivate ? "private" : "group", chatId } },
    });
    // A tool result can carry text a user, a memory entry or a web page wrote.
    // It reaches the model as a marked data block. The messages the harness
    // writes itself ("Error: ...") go out unwrapped.
    const asData = (source, result) => {
      const { text, removed } = cleanUntrusted(result, { max: TOOL_RESULT_BODY_CHARS });
      if (removed > 0) log.info({ chatId, field: `tool result ${source}`, removed }, "stripped invisible characters");
      return dataBlock({ nonce, kind: "tool result", source, body: text });
    };
    // Renders [[mention:ID]] tokens and posts the text; send_message and the
    // final reply both go through here. Returns how many Telegram messages went out.
    const deliverText = async (draft) => {
      const raw = polishReply(draft, { maxChars: maxReplyChars });
      // The prompt lists only some people (in a DM, just the speaker). A registry
      // person the model mentions by id must still render as a name, so look the
      // missing ids up. In a group, an id the registry doesn't know may still be a
      // member who never wrote to the bot; Telegram can tell. Anything else is dropped.
      for (const id of mentionIds(raw)) {
        if (known.has(id)) continue;
        const record = (await people.get(id)) ?? (isPrivate ? null : await io.memberPerson?.(id));
        if (record) known.set(id, record);
      }
      const mentionable = await mentionableIds(raw, input, known, io);
      const chunks = renderReply(raw, { people: known, mentionable, log });
      for (const chunk of chunks) await io.send(chunk);
      const ids = mentionIds(raw);
      return {
        sent: chunks.length,
        dropped: ids.filter((id) => !known.has(id)),
        plain: ids.filter((id) => known.has(id) && !mentionable.has(id)),
      };
    };
    let sentMessages = 0;
    // The media tool whose result reached the chat this turn, if any; the final
    // reply is then a short comment about it.
    let deliveredBy = null;
    // Texts already posted with send_message, normalized, so the final reply
    // never repeats one of them (small models often send a line and then say it again).
    const sameText = (t) => String(t ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const sentTexts = new Set();

    // Checks the final reply against the bot's recent ones in this chat and, when
    // it is too long or too repetitive, tells the model why and asks for another,
    // within what is left of the call budget. A post-tool comment that never passes
    // is dropped (the delivery already spoke); any other reply goes out as is.
    const variedReply = async (draft, { convo, callsLeft }) => {
      const kind = deliveredBy ?? "reply";
      // An ordinary reply over the cap is sent back to be shortened before
      // polishReply would have to cut it mid-thought.
      const rules = deliveredBy ? TOOL_COMMENT_RULES : { ...REPLY_RULES, maxChars: maxReplyChars };
      const ignore = [input.speaker.firstName, input.speaker.lastName, input.speaker.username, "clanker"].filter(Boolean);
      const recent = await comments.recent(chatId, kind);
      const ticRecent = recentForTics(recent, kind === "reply" ? [] : await comments.recent(chatId, "reply"));
      // Mention tokens are long ids; count them as one short name.
      const forCheck = (t) => t.replace(/\[\[mention:\d+\]\]/g, "@");
      const instructionsFor = (reason) => {
        if (deliveredBy) {
          return `Write one new comment about what ${deliveredBy} just delivered, addressed to the person who asked, at most ${rules.maxChars} characters.`;
        }
        if (/characters; the limit/.test(reason)) {
          return `Rewrite it shorter: one paragraph, at most ${rules.maxChars} characters, same meaning and language. Drop details nobody asked for.`;
        }
        return "Rewrite your reply with the same meaning and language but different words and a different opening.";
      };
      // Checks and the stored history use the text as the chat would see it:
      // without Markdown, ids or labels that polishReply strips anyway.
      const shown = (t) => polishReply(forCheck(t), { maxChars: Infinity });
      // A small model sometimes answers the harness note instead of the person
      // ("Perdón, aquí va una versión más corta: …"). Such a retry never goes out.
      const talksAboutRewrite = (t) => META_RE.test(t);

      let current = draft;
      // What goes out if no attempt passes: the latest usable one, never an empty retry.
      let fallback = draft;
      for (let attempt = 0; ; attempt++) {
        const text = shown(current);
        let reason = checkReply(text, recent, { ...rules, ignore, ticRecent });
        if (!reason && attempt > 0 && talksAboutRewrite(text)) reason = "it talks about the rewrite instead of just replying";
        if (!reason) {
          await comments.add(chatId, kind, text);
          return current;
        }
        if (text !== "" && !(attempt > 0 && talksAboutRewrite(text))) fallback = current;
        if (attempt >= Math.min(MAX_REPLY_RETRIES, callsLeft)) {
          log.info({ chatId, kind, reason }, "reply still rejected after retries");
          // The delivery already spoke, so a failing comment is just dropped. An
          // ordinary reply must still answer; record it so the next turn sees it.
          if (deliveredBy) return "";
          await comments.add(chatId, kind, shown(fallback));
          return fallback;
        }
        log.info({ chatId, kind, reason }, "reply rejected; asking the model for another");
        const recentList = recent.slice(-5).map((r) => JSON.stringify(r)).join(" / ") || "(none)";
        // This note and the rejected drafts live only in this call: nothing here
        // reaches the transcript, the memory or the chat.
        convo = [
          ...convo,
          {
            role: "user",
            content: [
              "⟦harness · not a message from anyone in the chat⟧",
              `Your last reply was not sent: ${reason}. ${instructionsFor(reason)}`,
              `Avoid the wording of these recent messages: ${recentList}.`,
              `Write only the replacement reply to ${input.speaker.displayName}, as if the rejected one never existed. Don't mention this note, a rewrite, a limit or a percentage.`,
            ].join("\n"),
          },
        ];
        const { message } = await complete(convo, {});
        current = String(message.content ?? "").trim();
        convo = [...convo, { role: "assistant", content: current }];
      }
    };

    const executeTool = async (name, args) => {
      if (name === "send_message") {
        if (sentMessages >= MAX_SENT_MESSAGES) {
          return `Error: you already sent ${MAX_SENT_MESSAGES} messages this turn; put anything else in your final reply.`;
        }
        const out = await deliverText(String(args.text ?? ""));
        if (out.sent === 0) return "Error: the message was empty; nothing was sent.";
        sentMessages += 1;
        sentTexts.add(sameText(args.text));
        // Tell the model when a mention didn't land, so it never claims a notice reached someone.
        let note = "";
        if (out.dropped.length) note += ` The mention of id ${out.dropped.join(", ")} was dropped: not in this chat or unknown.`;
        if (out.plain.length) note += ` Id ${out.plain.join(", ")} appeared as a plain name, without a notification.`;
        return `Sent message ${sentMessages}.${note}`;
      }
      if (agentTools.has(name)) {
        const result = await agentTools.execute(name, args);
        return result.startsWith("Error: ") ? result : asData(name, result);
      }
      if (mediaNames.has(name)) {
        let toolArgs = args;
        if (URL_TOOLS.has(name)) {
          const checked = checkMediaUrl(args.url);
          if (!checked.ok) return checked.error;
          toolArgs = { ...args, url: checked.url };
        }
        try {
          const output = await io.deliverTool(name, toolArgs);
          if (!output.startsWith("Nothing was sent to the chat")) deliveredBy = name;
          return asData(name, output);
        } catch (err) {
          log.warn({ err, chatId, tool: name }, "media tool failed");
          // The message can quote what the backend or a web page said, so it is data too.
          return asData(name, `Error: ${err.message}`);
        }
      }
      return `Error: unknown tool ${name}. Available tools: ${toolNames.join(", ")}.`;
    };

    const result = await runLoop({ messages, tools, complete, executeTool, maxCalls: maxLlmCalls });
    let { text, added } = result;
    // Only media tools count as work that answers the user. A turn that ran just
    // memory or telegram_info tools and ended with no text has said nothing.
    const ranMediaTool = result.toolCalls.some((c) => mediaNames.has(c.name));
    let ranTools = ranMediaTool;

    // Small models often answer a link with chat instead of calling a tool.
    // Memory tools don't count here: the model searches memory often, and that
    // alone must not stop the download.
    const url = input.text.match(URL_RE)?.[0];
    // yt-dlp can't download Spotify, so a Spotify link never forces a download.
    const isSpotify = /^https?:\/\/open\.spotify\.com\//i.test(url ?? "");
    if (url && !ranMediaTool && !isSpotify) {
      const checked = checkMediaUrl(url);
      if (!checked.ok) {
        log.warn({ chatId }, "fallback URL refused");
      } else {
        log.warn({ chatId }, "message has a URL but the model called no media tool; forcing download_video");
        const callId = `call_url_${input.messageId}`;
        const output = await io.deliverTool("download_video", { url: checked.url });
        if (!output.startsWith("Nothing was sent to the chat")) deliveredBy = "download_video";
        text = "";
        ranTools = true;
        added = [
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: callId, type: "function", function: { name: "download_video", arguments: JSON.stringify({ url: checked.url }) } }],
          },
          { role: "tool", tool_call_id: callId, content: asData("download_video", output) },
        ];
      }
    }

    // Messages already posted with send_message count as an answer too.
    if (text.trim() === "" && !ranTools && sentMessages === 0) throw new Error("empty model reply");

    if (sentTexts.has(sameText(text))) {
      log.info({ chatId }, "final reply repeats a sent message; not sending it twice");
    } else if (text.trim() !== "") {
      text = await variedReply(text, { convo: [...messages, ...added], callsLeft: maxLlmCalls - result.calls });
      // The transcript keeps the reply that went out, not the rejected drafts.
      const last = added.at(-1);
      if (last?.role === "assistant" && !last.tool_calls?.length) added = [...added.slice(0, -1), { ...last, content: text }];
      await deliverText(text);
    }
    // The answer is out; saving and compacting aren't "typing".
    io.stopTyping?.();

    await transcript.appendTurn(chatId, [userEntry, ...entriesFromMessages(added, now())]);
    log.info({ chatId, llmCalls: result.calls, tools: result.toolCalls.map((c) => c.name) }, "turn done");

    await compactAfterReply(chatId, agentTools.touched);
  }

  return {
    // The "typing…" status starts at once, even while this turn waits for an
    // earlier one in the same chat, and stops as soon as the reply is out.
    handleTurn: async (input, io) => {
      const stopTyping = io.startTyping?.() ?? (() => {});
      try {
        return await store.withLock(`chat:${input.chat.id}`, () => runTurn(input, { ...io, stopTyping }));
      } finally {
        stopTyping();
      }
    },

    // Forgets the conversation of one chat. Long-term memory stays.
    reset: (chatId) => store.withLock(`chat:${chatId}`, () => transcript.clear(chatId)),

    // A turn that failed sent the user an error notice the model never saw. Keep
    // both in the transcript so a later "wtf?" reads as a reply to the bot's own
    // message, not to some outside "system".
    recordFailure: (input, notice) =>
      store.withLock(`chat:${input.chat.id}`, async () => {
        const candidates = await people.inChat(input.chat.id);
        await transcript.appendTurn(input.chat.id, [
          userEntryFor(input, [...candidates, input.speaker]),
          { type: "assistant", ts: now().toISOString(), text: notice },
        ]);
      }),
  };
}
