import type { CommandContext, Context, Filter } from "grammy";
import type { Chat, User } from "grammy/types";
import { getChat, resetChat } from "../ai/chat-store";
import { type CompactionResult, compactChat } from "../ai/compaction";
import { config } from "../config";
import { logger } from "../logger";
import { chatReplier, type Replier } from "./replier";

export type CommandInput = { chat: Chat; from: User; replier: Replier };

type Command = (input: CommandInput) => Promise<unknown>;

export function formatCompactionNotice({
  tokensBefore,
  tokensAfter,
}: CompactionResult): string {
  const approximately = (tokens?: number) =>
    tokens === undefined ? "?" : `~${tokens}`;

  return `Compacted conversation history (${approximately(tokensBefore)} → ${approximately(tokensAfter)} tokens). Earlier messages are now a summary.`;
}

function start({ replier }: CommandInput) {
  return replier.send("Up and running! 🫡");
}

function chatInfo({ chat, from, replier }: CommandInput) {
  const name = "title" in chat ? chat.title : chat.username;

  return replier.send(
    [
      "## Chat Info",
      `- Chat ID: \`${chat.id}\``,
      `- Type: \`${chat.type}\``,
      `- Name: ${name ?? "none"}`,
      `- Your user ID: \`${from.id}\``,
    ].join("\n"),
  );
}

function newChat({ chat, replier }: CommandInput) {
  resetChat(chat.id);
  return replier.send("Chat history cleared.");
}

async function compact({ chat, replier }: CommandInput) {
  let result: CompactionResult | undefined;
  try {
    result = await replier.whileTyping(() => compactChat(chat.id));
  } catch (error) {
    logger.error("compaction.failed", error, { chatId: chat.id });
    return replier.send("Couldn't compact the conversation.");
  }

  return replier.send(
    result ? formatCompactionNotice(result) : "Nothing to compact.",
  );
}

function debug({ chat, replier }: CommandInput) {
  const { history, summary, tokenUsage, lastContextTokens } = getChat(chat.id);
  const { totalInputTokens, totalOutputTokens } = tokenUsage;
  const threshold = config.AUTO_COMPACT_TOKEN_THRESHOLD;
  const count = (role: string) =>
    history.filter((message) => message.role === role).length;

  const context =
    lastContextTokens === undefined
      ? "not measured yet"
      : `\`${lastContextTokens}\` tokens`;
  const autoCompaction = threshold
    ? `auto at \`${threshold}\` tokens`
    : "auto-compaction off";

  return replier.send(
    [
      "## Debug Stats",
      `- Chat: \`${chat.id}\``,
      `- Model: \`${config.chatModel.modelId}\``,
      `- History: \`${history.length}\` msgs (user \`${count("user")}\`, assistant \`${count("assistant")}\`, tool \`${count("tool")}\`)`,
      `- Context: ${context} (${autoCompaction})`,
      `- Summary: ${summary ? `\`${summary.length}\` chars` : "none"}`,
      `- Usage: \`${totalInputTokens + totalOutputTokens}\` tokens (in \`${totalInputTokens}\`, out \`${totalOutputTokens}\`)`,
    ].join("\n"),
  );
}

function whichModel({ replier }: CommandInput) {
  return replier.send(`\`${config.chatModel.modelId}\``);
}

export const commands = new Map<string, Command>([
  ["start", start],
  ["ping", start],
  ["chatinfo", chatInfo],
  ["newchat", newChat],
  ["compact", compact],
  ["debug", debug],
  ["whichmodel", whichModel],
]);

export function commandHandler(command: Command) {
  return (ctx: CommandContext<Filter<Context, "message">>) =>
    command({ chat: ctx.chat, from: ctx.from, replier: chatReplier(ctx) });
}
