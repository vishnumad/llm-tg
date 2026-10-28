import type { Context, Filter } from "grammy";
import { logger } from "../logger";

const stoppableTurns = new Map<string, AbortController>();

const keyOf = (chatId: number, draftId: number) => `${chatId}:${draftId}`;

/** Let the stop button on a draft abort the turn writing it. */
export function stopButton(chatId: number, draftId: number) {
  const key = keyOf(chatId, draftId);
  const controller = new AbortController();
  stoppableTurns.set(key, controller);
  return {
    signal: controller.signal,
    release: () => {
      stoppableTurns.delete(key);
    },
  };
}

export function handleStopGeneration(
  ctx: Filter<Context, "stopped_message_generation">,
) {
  const { chat, draft_id } = ctx.update.stopped_message_generation;
  const controller = stoppableTurns.get(keyOf(chat.id, draft_id));
  logger.info("conversation.stop_requested", {
    chatId: chat.id,
    draftId: draft_id,
    running: controller !== undefined,
  });
  controller?.abort();
}
