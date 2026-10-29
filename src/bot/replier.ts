import { type Context, type Filter, GrammyError } from "grammy";
import { logger } from "../logger";
import {
  closeOpenFence,
  collapseHtml,
  escapeHtml,
  MAX_MESSAGE_LENGTH,
  markdownToTelegramHtml,
  splitMarkdown,
} from "./markdown";
import { createPreview } from "./preview";
import { stopButton } from "./stop";

/** Where a conversation's output goes: back into the chat, or a guest reply. */
export type Replier = {
  /** Show the bot as typing until `work` settles. */
  whileTyping<T>(work: () => Promise<T>): Promise<T>;
  /** Deliver the model's answer, written in markdown. */
  send(markdown: string): Promise<unknown>;
  /**
   * Plain text outside the answer, such as errors and compaction notices,
   * with optional detail tucked into an expandable quote below it.
   */
  notice(text: string, detail?: string): Promise<unknown>;
  /** Preview the model's answer while it's being written. */
  stream(): AnswerStream;
};

export type AnswerStream = {
  /** Throttled, and never throws. */
  update(markdown: string): void;
  finish(markdown: string): Promise<void>;
  cancel(): Promise<void>;
  /** Set when the user can stop the answer. */
  abortSignal?: AbortSignal;
};

type Deliver = (text: string, parseMode?: "HTML") => Promise<unknown>;

// Telegram clears a chat action after five seconds.
const TYPING_INTERVAL_MS = 4_000;

const COLLAPSE_THRESHOLD = 1_000;

// Drafts are made for streaming, while edits count against a group's limit of
// about 20 messages a minute.
const DRAFT_INTERVAL_MS = 500;
const EDIT_INTERVAL_MS = 1_500;

function shouldCollapse(markdown: string): boolean {
  return markdown.trim().length > COLLAPSE_THRESHOLD;
}

/**
 * Deliver markdown as Telegram HTML, falling back to the raw markdown when
 * Telegram rejects the conversion, such as tags crossed by overlapping markers.
 */
async function deliverMarkdown(
  markdown: string,
  deliver: Deliver,
  collapse = false,
) {
  try {
    const html = markdownToTelegramHtml(markdown);
    await deliver(collapse ? collapseHtml(html) : html, "HTML");
  } catch (error) {
    if (
      !(error instanceof GrammyError) ||
      !error.description.includes("can't parse entities")
    ) {
      throw error;
    }
    logger.info("reply.html_rejected", { description: error.description });
    if (collapse) {
      await deliver(collapseHtml(escapeHtml(markdown)), "HTML");
    } else {
      await deliver(markdown);
    }
  }
}

function ignoreNotModified(deliver: Deliver): Deliver {
  return async (text, parseMode) => {
    try {
      await deliver(text, parseMode);
    } catch (error) {
      if (
        !(error instanceof GrammyError) ||
        !error.description.includes("message is not modified")
      ) {
        throw error;
      }
    }
  };
}

/** Deliver a notice, folding its detail into an expandable quote. */
function deliverNotice(
  text: string,
  detail: string | undefined,
  deliver: Deliver,
) {
  if (!detail) {
    return deliver(text);
  }
  // Telegram limits the visible text, so only the detail is clipped to fit.
  const room = MAX_MESSAGE_LENGTH - text.length - 1;
  const clipped =
    detail.length > room ? `${detail.slice(0, room - 1)}…` : detail;
  return deliver(
    `${escapeHtml(text)}\n<blockquote expandable>${escapeHtml(clipped)}</blockquote>`,
    "HTML",
  );
}

function answerStream(
  renderPreview: (markdown: string) => Promise<void>,
  intervalMs: number,
  deliver: (markdown: string) => Promise<unknown>,
  discard?: () => Promise<void>,
): AnswerStream {
  const preview = createPreview(renderPreview, intervalMs);
  return {
    update: preview.update,
    async finish(markdown) {
      await preview.stop();
      await deliver(markdown);
    },
    async cancel() {
      await preview.stop();
      await discard?.();
    },
  };
}

/** Preview chunks, with the code block the model is still writing closed. */
function previewChunks(markdown: string): string[] {
  const chunks = splitMarkdown(markdown);
  chunks.push(closeOpenFence(chunks.pop() ?? ""));
  return chunks;
}

export function chatReplier(ctx: Filter<Context, "message">): Replier {
  const chatId = ctx.chat.id;

  /** The messages of one answer, sent or edited to match its chunks. */
  function answerMessages() {
    const ids: number[] = [];
    const shown: string[] = [];

    async function remove(removed: number[]) {
      await Promise.all(
        removed.map((id) => ctx.api.deleteMessage(chatId, id).catch(() => {})),
      );
    }

    async function show(chunks: string[], collapse: boolean) {
      for (const [index, chunk] of chunks.entries()) {
        const key = `${collapse}:${chunk}`;
        if (shown[index] === key) {
          continue;
        }
        const id = ids[index];
        const deliver: Deliver =
          id === undefined
            ? async (text, parse_mode) => {
                const message = await ctx.reply(text, {
                  parse_mode,
                  // Only the first message of an answer replies to the prompt.
                  reply_parameters:
                    index === 0
                      ? {
                          message_id: ctx.msg.message_id,
                          allow_sending_without_reply: true,
                        }
                      : undefined,
                });
                ids[index] = message.message_id;
              }
            : ignoreNotModified((text, parse_mode) =>
                ctx.api.editMessageText(chatId, id, text, { parse_mode }),
              );
        await deliverMarkdown(chunk, deliver, collapse);
        shown[index] = key;
      }
      // A new model step starts its text over, so it can need fewer messages.
      shown.splice(chunks.length);
      await remove(ids.splice(chunks.length));
    }

    return {
      preview: (markdown: string) => show(previewChunks(markdown), false),
      answer: (markdown: string) =>
        show(splitMarkdown(markdown), shouldCollapse(markdown)),
      delete: () => remove(ids.splice(0)),
    };
  }

  return {
    async whileTyping(work) {
      // Purely cosmetic, so a failed chat action never holds up the answer.
      const sendTyping = () =>
        ctx.replyWithChatAction("typing").catch(() => {});
      sendTyping();
      const timer = setInterval(sendTyping, TYPING_INTERVAL_MS);
      try {
        return await work();
      } finally {
        clearInterval(timer);
      }
    },

    send: (markdown) => answerMessages().answer(markdown),

    notice: (text, detail) =>
      deliverNotice(text, detail, (text, parse_mode) =>
        ctx.reply(text, { parse_mode }),
      ),

    stream() {
      const messages = answerMessages();
      return answerStream(
        messages.preview,
        EDIT_INTERVAL_MS,
        messages.answer,
        messages.delete,
      );
    },
  };
}

/** Like `chatReplier`, but streams into a draft the user can stop. */
export function draftReplier(ctx: Filter<Context, "message">): Replier {
  const replier = chatReplier(ctx);
  const chatId = ctx.chat.id;
  const draftId = ctx.msg.message_id;

  const sendDraft: Deliver = (text, parse_mode) =>
    ctx.api.sendMessageDraft(chatId, draftId, text, {
      parse_mode,
      message_thread_id: ctx.msg.is_topic_message
        ? ctx.msg.message_thread_id
        : undefined,
      can_stop: true,
      keep_on_stop: true,
    });

  return {
    ...replier,
    stream() {
      const stop = stopButton(chatId, draftId);
      const stream = answerStream(
        (markdown) =>
          deliverMarkdown(previewChunks(markdown).at(-1) ?? "", sendDraft),
        DRAFT_INTERVAL_MS,
        (markdown) => {
          stop.release();
          return replier.send(markdown);
        },
        async () => stop.release(),
      );
      return { ...stream, abortSignal: stop.signal };
    },
  };
}

const PLACEHOLDER = "Thinking…";

/**
 * A guest query buys exactly one message, and its id expires within seconds -
 * well before a model turn finishes. So the message is claimed up front with a
 * placeholder, and the answer is edited into it later.
 */
export async function guestReplier(
  ctx: Filter<Context, "guest_message">,
): Promise<Replier> {
  const { inline_message_id } = await ctx.answerGuestQuery({
    type: "article",
    id: String(ctx.msg.message_id),
    title: PLACEHOLDER,
    input_message_content: { message_text: PLACEHOLDER },
  });

  const editInline = ignoreNotModified((text, parseMode) =>
    ctx.api.editMessageTextInline(inline_message_id, text, {
      parse_mode: parseMode,
      link_preview_options: { is_disabled: true },
    }),
  );

  // Previews skip this, so an error can still replace a partial answer.
  let answered = false;
  async function edit(text: string, parseMode?: "HTML") {
    await editInline(text, parseMode);
    answered = true;
  }

  function fitOneMessage(markdown: string): string {
    const [first, ...rest] = splitMarkdown(markdown, MAX_MESSAGE_LENGTH - 2);
    return rest.length > 0 ? `${first}\n…` : first;
  }

  const send = (markdown: string) =>
    deliverMarkdown(fitOneMessage(markdown), edit, shouldCollapse(markdown));

  return {
    // Chat actions need chat membership, which a guest doesn't have.
    whileTyping: (work) => work(),

    send,

    // Once the answer is in, a notice would overwrite it.
    notice: async (text, detail) => {
      if (!answered) {
        await deliverNotice(text, detail, edit);
      }
    },

    stream: () =>
      answerStream(
        (markdown) =>
          deliverMarkdown(fitOneMessage(closeOpenFence(markdown)), editInline),
        EDIT_INTERVAL_MS,
        send,
      ),
  };
}
