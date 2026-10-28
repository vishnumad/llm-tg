import type { Context, Filter } from "grammy";
import { logger } from "../logger";

/** Turns that can still be stopped, by chat and draft. */
const running = new Map<string, AbortController>();

const keyOf = (chatId: number, draftId: number) => `${chatId}:${draftId}`;

/** Make a turn stoppable from its draft's stop button. */
export function registerStop(chatId: number, draftId: number): AbortSignal {
  const controller = new AbortController();
  running.set(keyOf(chatId, draftId), controller);
  return controller.signal;
}

export function releaseStop(chatId: number, draftId: number) {
  running.delete(keyOf(chatId, draftId));
}

/**
 * Must run outside the chat's queue, as the turn it stops is what holds the
 * queue. A stop for a turn that already finished does nothing.
 */
export function handleStopGeneration(
  ctx: Filter<Context, "stopped_message_generation">,
) {
  const { chat, draft_id } = ctx.update.stopped_message_generation;
  const controller = running.get(keyOf(chat.id, draft_id));
  logger.info("conversation.stop_requested", {
    chatId: chat.id,
    draftId: draft_id,
    running: controller !== undefined,
  });
  controller?.abort();
}
