// Per-chat rolling conversation history, in memory.
// Swap this Map for Redis/Postgres if the bot ever needs to survive restarts
// or run more than one replica.

const MAX_HISTORY = 10;

const histories = new Map();

export function getHistory(chatId) {
  return histories.get(chatId) ?? [];
}

export function appendToHistory(chatId, message) {
  const history = histories.get(chatId) ?? [];
  history.push(message);
  // Trim aggressively — local models have small context windows.
  while (history.length > MAX_HISTORY) history.shift();
  // A tool result is only valid right after its assistant tool call; drop
  // any orphaned by trimming or the LLM API will reject the request.
  while (history[0]?.role === "tool") history.shift();
  histories.set(chatId, history);
}

export function clearHistory(chatId) {
  histories.delete(chatId);
}
