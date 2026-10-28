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
import { registerStop, releaseStop } from "./stop";

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
  /** Show the model's answer as it's written, then deliver it in full. */
  stream(): AnswerStream;
};

/** One answer, previewed while the model writes it. */
export type AnswerStream = {
  /** Show the answer so far. Throttled, and never throws. */
  update(markdown: string): void;
  /** Deliver the finished answer in place of the preview. */
  finish(markdown: string): Promise<void>;
  /** Stop previewing an answer that won't be finished. */
  cancel(): Promise<void>;
  /** Aborted when the user stops the answer, if they're able to. */
  abortSignal?: AbortSignal;
};

type Deliver = (text: string, parseMode?: "HTML") => Promise<unknown>;

// Telegram clears a chat action after five seconds.
const TYPING_INTERVAL_MS = 4_000;

const COLLAPSE_THRESHOLD = 1_000;

// Drafts are built for streaming. Edits count against the chat's rate limit,
// which allows about 20 messages a minute in a group.
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

function isNotModified(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    error.description.includes("message is not modified")
  );
}

/** Wrap an edit so that rendering the same text again isn't an error. */
function ignoreNotModified(deliver: Deliver): Deliver {
  return async (text, parseMode) => {
    try {
      await deliver(text, parseMode);
    } catch (error) {
      if (!isNotModified(error)) {
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

/**
 * Replies in a group: the answer is sent as soon as it starts, then edited as
 * it grows, spilling into further messages past Telegram's length limit.
 */
export function chatReplier(ctx: Filter<Context, "message">): Replier {
  const replyTo = {
    message_id: ctx.msg.message_id,
    allow_sending_without_reply: true,
  };
  // Only the first message of an answer replies to the prompt.
  const reply = (index: number) => (text: string, parse_mode?: "HTML") =>
    ctx.reply(text, {
      parse_mode,
      reply_parameters: index === 0 ? replyTo : undefined,
    });
  const post: Deliver = (text, parse_mode) => ctx.reply(text, { parse_mode });

  /** Messages of a streamed answer that failed, to be replaced by its error. */
  let abandoned: number[] = [];

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

    async send(markdown) {
      const collapse = shouldCollapse(markdown);
      const chunks = splitMarkdown(markdown);
      for (const [index, chunk] of chunks.entries()) {
        await deliverMarkdown(chunk, reply(index), collapse);
      }
    },

    async notice(text, detail) {
      const [first, ...rest] = abandoned;
      abandoned = [];
      if (first === undefined) {
        return deliverNotice(text, detail, post);
      }
      await deliverNotice(
        text,
        detail,
        ignoreNotModified((text, parse_mode) =>
          ctx.api.editMessageText(ctx.chat.id, first, text, { parse_mode }),
        ),
      );
      await Promise.all(
        rest.map((id) =>
          ctx.api.deleteMessage(ctx.chat.id, id).catch(() => {}),
        ),
      );
    },

    stream() {
      const messageIds: number[] = [];
      // What each message shows, so unchanged ones aren't edited again.
      const shown: string[] = [];

      async function render(chunks: string[], collapse: boolean) {
        for (const [index, chunk] of chunks.entries()) {
          const key = `${collapse}:${chunk}`;
          if (shown[index] === key) {
            continue;
          }
          const id = messageIds[index];
          const deliver: Deliver =
            id === undefined
              ? async (text, parseMode) => {
                  const message = await reply(index)(text, parseMode);
                  messageIds[index] = message.message_id;
                }
              : ignoreNotModified((text, parse_mode) =>
                  ctx.api.editMessageText(ctx.chat.id, id, text, {
                    parse_mode,
                  }),
                );
          await deliverMarkdown(chunk, deliver, collapse);
          shown[index] = key;
        }
        // A new model step starts its text over, which can leave fewer chunks.
        const extra = messageIds.splice(chunks.length);
        shown.splice(chunks.length);
        await Promise.all(
          extra.map((id) =>
            ctx.api.deleteMessage(ctx.chat.id, id).catch(() => {}),
          ),
        );
      }

      const preview = createPreview(async (markdown) => {
        if (!markdown.trim()) {
          return;
        }
        const chunks = splitMarkdown(markdown);
        chunks.push(closeOpenFence(chunks.pop() ?? ""));
        return render(chunks, false);
      }, EDIT_INTERVAL_MS);

      return {
        update: preview.update,
        async finish(markdown) {
          await preview.stop();
          await render(splitMarkdown(markdown), shouldCollapse(markdown));
        },
        async cancel() {
          await preview.stop();
          abandoned = [...messageIds];
        },
      };
    },
  };
}

/** Set once Telegram turns a draft down, so later turns go straight to edits. */
let draftsUnavailable = false;

export function canUseDrafts(): boolean {
  return !draftsUnavailable;
}

/**
 * Replies in a private chat: the answer streams as a draft, with a button to
 * stop it, and is sent as a message once finished.
 */
export function draftReplier(ctx: Filter<Context, "message">): Replier {
  const replier = chatReplier(ctx);

  return {
    ...replier,
    stream() {
      const chatId = ctx.chat.id;
      const draftId = ctx.msg.message_id;
      const abortSignal = registerStop(chatId, draftId);
      // Takes over the preview if Telegram turns drafts down.
      let fallback: AnswerStream | undefined;

      const sendDraft = (text: string, parse_mode?: "HTML") =>
        ctx.api.sendMessageDraft(chatId, draftId, text, {
          parse_mode,
          message_thread_id: ctx.msg.is_topic_message
            ? ctx.msg.message_thread_id
            : undefined,
          can_stop: true,
          keep_on_stop: true,
        });

      const preview = createPreview(async (markdown) => {
        if (fallback) {
          return fallback.update(markdown);
        }
        // A draft holds one message, so it shows the latest part.
        const latest = splitMarkdown(markdown).at(-1) ?? "";
        try {
          await deliverMarkdown(closeOpenFence(latest), sendDraft);
        } catch (error) {
          if (!(error instanceof GrammyError) || error.error_code !== 400) {
            throw error;
          }
          logger.info("reply.drafts_unavailable", {
            description: error.description,
          });
          draftsUnavailable = true;
          fallback = replier.stream();
          fallback.update(markdown);
        }
      }, DRAFT_INTERVAL_MS);

      return {
        update: preview.update,
        abortSignal,
        async finish(markdown) {
          await preview.stop();
          releaseStop(chatId, draftId);
          // The draft disappears once the message arrives.
          await (fallback ? fallback.finish(markdown) : replier.send(markdown));
        },
        async cancel() {
          await preview.stop();
          releaseStop(chatId, draftId);
          await fallback?.cancel();
        },
      };
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

  // A preview doesn't count, so an error can still replace a partial answer.
  let answered = false;
  async function edit(text: string, parseMode?: "HTML") {
    await editInline(text, parseMode);
    answered = true;
  }

  /** The answer cut to the one message a guest reply gets. */
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

    stream() {
      let previewed: string | undefined;
      const preview = createPreview(async (markdown) => {
        if (markdown.trim()) {
          const cut = fitOneMessage(closeOpenFence(markdown));
          await deliverMarkdown(cut, editInline);
          previewed = cut;
        }
      }, EDIT_INTERVAL_MS);
      return {
        update: preview.update,
        async finish(markdown) {
          await preview.stop();
          if (
            previewed === fitOneMessage(markdown) &&
            !shouldCollapse(markdown)
          ) {
            answered = true;
          } else {
            await send(markdown);
          }
        },
        cancel: preview.stop,
      };
    },
  };
}
