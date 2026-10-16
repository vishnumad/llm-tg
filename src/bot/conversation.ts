import { sequentialize } from "@grammyjs/runner";
import type { Context, Filter } from "grammy";
import { generateReply } from "../ai/chat";
import { autoCompact, type CompactionResult } from "../ai/compaction";
import { logger } from "../logger";
import { downloadPhotos } from "./photos";
import { chatReplier, guestReplier, type Replier } from "./replier";
import { extractPrompt, stripBotMention } from "./triggers";

/**
 * Middleware that runs each chat's updates one at a time, while different
 * chats run concurrently, so nothing else touches a chat mid-turn.
 */
export const inChatOrder = sequentialize((ctx: Context) =>
  ctx.chat?.id.toString(),
);

export function formatCompactionNotice({
  tokensBefore,
  tokensAfter,
}: CompactionResult): string {
  const approximately = (tokens?: number) =>
    tokens === undefined ? "?" : `~${tokens}`;

  return `Compacted conversation history (${approximately(tokensBefore)} → ${approximately(tokensAfter)} tokens). Earlier messages are now a summary.`;
}

async function respond(
  ctx: Filter<Context, "message"> | Filter<Context, "guest_message">,
  replier: Replier,
  prompt: string,
) {
  const { msg } = ctx;
  const log = logger.child({ chatId: msg.chat.id, messageId: msg.message_id });

  let answer: string;
  try {
    answer = await replier.whileTyping(async () =>
      generateReply(msg.chat.id, {
        text: prompt,
        images: await downloadPhotos(ctx),
        context: {
          firstname: msg.from.first_name,
          userId: String(msg.from.id),
          timestamp: new Date(msg.date * 1000).toUTCString(),
          replyingTo:
            msg.reply_to_message?.text ?? msg.reply_to_message?.caption,
        },
      }),
    );
  } catch (error) {
    log.error("conversation.failed", error);
    await replier.notice(
      "Couldn't generate a response",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  await replier.send(answer);
  log.info("conversation.replied");

  try {
    const compaction = await autoCompact(msg.chat.id);
    if (compaction) {
      await replier.notice(formatCompactionNotice(compaction));
    }
  } catch (error) {
    log.error("compaction.failed", error);
  }
}

export async function handleMessage(ctx: Filter<Context, "message">) {
  const prompt = extractPrompt(ctx);
  if (prompt !== undefined) {
    await respond(ctx, chatReplier(ctx), prompt);
  }
}

export async function handleGuestMessage(
  ctx: Filter<Context, "guest_message">,
) {
  // Claimed before queueing, as the guest query could expire while an earlier
  // mention in the same chat is still being answered.
  const replier = await guestReplier(ctx);
  await inChatOrder(ctx, () => respond(ctx, replier, stripBotMention(ctx)));
}
