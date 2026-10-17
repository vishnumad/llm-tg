import type { CommandContext, Context, Filter } from "grammy";
import type { Chat, User } from "grammy/types";
import { getModelId } from "../ai/chat";
import { getChat, resetChat, updateChat } from "../ai/chat-store";
import { type CompactionResult, compactChat } from "../ai/compaction";
import { config } from "../config";
import { logger } from "../logger";
import { chatReplier, type Replier } from "./replier";

/** What a command needs, whether it came as a command or a guest mention. */
export type CommandInput = {
  chat: Chat;
  from: User;
  /** The text after the command name. */
  args: string;
  replier: Replier;
};

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
  const chatId = chat.id;
  const { history, summary, tokenUsage, lastContextTokens } = getChat(chatId);
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
      `- Chat: \`${chatId}\``,
      `- Model: \`${getModelId(chatId)}\``,
      `- History: \`${history.length}\` msgs (user \`${count("user")}\`, assistant \`${count("assistant")}\`, tool \`${count("tool")}\`)`,
      `- Context: ${context} (${autoCompaction})`,
      `- Summary: ${summary ? `\`${summary.length}\` chars` : "none"}`,
      `- Usage: \`${totalInputTokens + totalOutputTokens}\` tokens (in \`${totalInputTokens}\`, out \`${totalOutputTokens}\`)`,
    ].join("\n"),
  );
}

function switchModel({ chat, args, replier }: CommandInput) {
  const requested = args.trim();
  if (!requested) {
    return replier.send(
      "Usage: /switchmodel <groq-model-id>, or /switchmodel default\nExample: /switchmodel moonshotai/kimi-k2-instruct-0905",
    );
  }

  updateChat(chat.id, (stored) => {
    stored.modelId = requested === "default" ? undefined : requested;
  });
  const modelId = getModelId(chat.id);
  logger.info("model.switched", { chatId: chat.id, modelId });
  return replier.send(`Model set to \`${modelId}\``);
}

function whichModel({ chat, replier }: CommandInput) {
  return replier.send(`\`${getModelId(chat.id)}\``);
}

/** Every command, by the name it's invoked with. */
export const commands: Record<string, Command> = {
  start,
  ping: start,
  chatinfo: chatInfo,
  newchat: newChat,
  compact,
  debug,
  switchmodel: switchModel,
  whichmodel: whichModel,
};

/** Adapts a command to grammY's `bot.command` handler. */
export function commandHandler(command: Command) {
  return (ctx: CommandContext<Filter<Context, "message">>) =>
    command({
      chat: ctx.chat,
      from: ctx.from,
      args: ctx.match,
      replier: chatReplier(ctx),
    });
}

/**
 * The command in a guest mention's prompt, such as `/switchmodel foo`.
 * `undefined` if the prompt isn't a known command.
 */
export function parseGuestCommand(
  prompt: string,
): { command: Command; args: string } | undefined {
  const match = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(prompt);
  const name = match?.[1].toLowerCase();
  if (!match || !name || !Object.hasOwn(commands, name)) {
    return undefined;
  }
  return { command: commands[name], args: match[2] ?? "" };
}
