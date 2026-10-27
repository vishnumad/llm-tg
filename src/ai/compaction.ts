import { generateText } from "ai";
import { config } from "../config";
import { logger } from "../logger";
import { addUsage, getChat, updateChat } from "./chat-store";
import { model } from "./model";
import { renderTranscript } from "./transcript";

const SUMMARY_SYSTEM_PROMPT = [
  "You compress chat conversations so a chat bot can keep talking without the full history.",
  "Write a dense, factual summary of the conversation below, as context for the bot that will continue it - not as prose for a human reader.",
  "Preserve, in this order and only where present:",
  "- who is taking part, and anything they stated about themselves or their preferences",
  "- what they are trying to do, and any question left open or unanswered",
  "- decisions, conclusions and commitments reached",
  "- concrete facts, figures, names, URLs and code that were established, including anything found by the web search tool",
  "- anything the bot promised to do or remember",
  "Drop pleasantries, repetition and any ephemeral or unimportant information. Do not speculate, and do not invent anything that is not in the transcript.",
  "Output only the summary itself: plain prose and short bullets, no preamble, no sign-off, no markdown headings.",
].join("\n");

export type CompactionResult = {
  tokensBefore?: number;
  tokensAfter?: number;
};

function buildSummaryPrompt(
  transcript: string,
  previousSummary: string | undefined,
): string {
  if (!previousSummary) {
    return `<transcript>\n${transcript}\n</transcript>`;
  }

  // Without the previous summary, a second compaction would silently drop
  // everything from before the first one.
  return [
    "This conversation was compacted once before. Here is the summary produced then, covering everything that came before the transcript:",
    "",
    "<previous_summary>",
    previousSummary,
    "</previous_summary>",
    "",
    "And here is what has been said since. Produce a single summary covering both.",
    "",
    "<transcript>",
    transcript,
    "</transcript>",
  ].join("\n");
}

/**
 * Summarise the chat's history into its running summary and drop the history.
 * Resolves to `undefined` if there was nothing to compact.
 */
export async function compactChat(
  chatId: number,
): Promise<CompactionResult | undefined> {
  const { history, summary, lastContextTokens } = getChat(chatId);
  const transcript = renderTranscript(history);
  if (!transcript) {
    return undefined;
  }

  const result = await generateText({
    model,
    system: SUMMARY_SYSTEM_PROMPT,
    prompt: buildSummaryPrompt(transcript, summary),
    timeout: config.MODEL_TIMEOUT_MS,
  });

  const newSummary = result.text.trim();
  if (!newSummary) {
    throw new Error("The model returned an empty summary");
  }

  updateChat(chatId, (chat) => {
    chat.summary = newSummary;
    chat.history = [];
    chat.lastContextTokens = undefined;
    addUsage(chat, result.totalUsage);
  });

  const compaction = {
    tokensBefore: lastContextTokens,
    tokensAfter: result.usage.outputTokens,
  };
  logger.info("compaction.completed", {
    chatId,
    compactedCount: history.length,
    ...compaction,
  });
  return compaction;
}

export async function autoCompact(
  chatId: number,
): Promise<CompactionResult | undefined> {
  const threshold = config.AUTO_COMPACT_TOKEN_THRESHOLD;
  const contextTokens = getChat(chatId).lastContextTokens;
  if (!threshold || !contextTokens || contextTokens < threshold) {
    return undefined;
  }

  logger.info("compaction.triggered", { chatId, contextTokens, threshold });
  return compactChat(chatId);
}
