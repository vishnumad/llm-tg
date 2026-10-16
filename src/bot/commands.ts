import type { CommandContext, Context, Filter } from "grammy";
import { getModelId } from "../ai/chat";
import { getChat, resetChat, updateChat } from "../ai/chat-store";
import { config } from "../config";
import { logger } from "../logger";
import { compactConversation } from "./conversation";
import { chatReplier } from "./replier";

type CommandCtx = CommandContext<Filter<Context, "message">>;

function reply(ctx: CommandCtx, markdown: string) {
  return chatReplier(ctx).send(markdown);
}

export function handleStart(ctx: CommandCtx) {
  return reply(ctx, "Up and running! 🫡");
}

export function handleChatInfo(ctx: CommandCtx) {
  const { chat, from } = ctx;
  const name = "title" in chat ? chat.title : chat.username;

  return reply(
    ctx,
    [
      "## Chat Info",
      `- Chat ID: \`${chat.id}\``,
      `- Type: \`${chat.type}\``,
      `- Name: ${name ?? "none"}`,
      `- Your user ID: \`${from.id}\``,
    ].join("\n"),
  );
}

export function handleNewChat(ctx: CommandCtx) {
  resetChat(ctx.chat.id);
  return reply(ctx, "Chat history cleared.");
}

export function handleCompact(ctx: CommandCtx) {
  return compactConversation(ctx.chat.id, chatReplier(ctx));
}

export function handleDebug(ctx: CommandCtx) {
  const chatId = ctx.chat.id;
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

  return reply(
    ctx,
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

export function handleSwitchModel(ctx: CommandCtx) {
  const requested = ctx.match.trim();
  if (!requested) {
    return reply(
      ctx,
      "Usage: /switchmodel <groq-model-id>, or /switchmodel default\nExample: /switchmodel moonshotai/kimi-k2-instruct-0905",
    );
  }

  updateChat(ctx.chat.id, (chat) => {
    chat.modelId = requested === "default" ? undefined : requested;
  });
  const modelId = getModelId(ctx.chat.id);
  logger.info("model.switched", { chatId: ctx.chat.id, modelId });
  return reply(ctx, `Model set to \`${modelId}\``);
}

export function handleWhichModel(ctx: CommandCtx) {
  return reply(ctx, `\`${getModelId(ctx.chat.id)}\``);
}
