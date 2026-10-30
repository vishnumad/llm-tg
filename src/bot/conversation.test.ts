import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ToolExecutionOptions, ToolSet } from "ai";
import { Api, Context, type Filter, InputFile } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { getChat, updateChat } from "../ai/chat-store";
import { imageProvider } from "../ai/image";
import type { ImageProvider } from "../ai/image/provider";
import { config } from "../config";
import { generateText, uniqueChatId } from "../test-setup";
import { handleGuestMessage, handleMessage } from "./conversation";

type ApiCall = { method: string; payload: Record<string, unknown> };

const BOT = { id: 42, is_bot: true, first_name: "MyBot", username: "MyBot" };
const SAM = { id: 7, is_bot: false, first_name: "Sam" };

let calls: ApiCall[];
/** Turns a call into a Telegram error by returning its description. */
let failCall: (call: ApiCall) => string | undefined;

const RESULTS: Record<string, unknown> = {
  answerGuestQuery: { inline_message_id: "inline" },
  getFile: { file_id: "file", file_path: "photos/file.jpg" },
  sendPhoto: {
    message_id: 99,
    photo: [{ file_id: "small" }, { file_id: "large" }],
  },
};

// Records every Telegram call instead of sending it.
const api = new Api("test");
api.config.use(async (_prev, method, payload) => {
  const call = { method, payload: payload as Record<string, unknown> };
  calls.push(call);
  const description = failCall(call);
  const response = description
    ? { ok: false, error_code: 400, description }
    : {
        ok: true,
        result: RESULTS[method] ?? true,
      };
  return response as never;
});

beforeEach(() => {
  calls = [];
  failCall = () => undefined;
  generateText.mockReset();
});

function contextFor<C extends Context>(update: Omit<Update, "update_id">) {
  return new Context(
    { update_id: 1, ...update },
    api,
    BOT as UserFromGetMe,
  ) as C;
}

function gCommand(chatId: number, prompt: string) {
  return contextFor<Filter<Context, "message">>({
    message: {
      message_id: 1,
      date: 0,
      chat: { id: chatId, type: "group", title: "Test" },
      from: SAM,
      text: `/g ${prompt}`,
      entities: [{ type: "bot_command", offset: 0, length: 2 }],
    },
  });
}

function guestMention(chatId: number, messageId: number, prompt = "hi") {
  return contextFor<Filter<Context, "guest_message">>({
    guest_message: {
      message_id: messageId,
      guest_query_id: `query-${messageId}`,
      date: 0,
      chat: { id: chatId, type: "group", title: "Test" },
      from: SAM,
      text: `@MyBot ${prompt}`,
      entities: [{ type: "mention", offset: 0, length: 6 }],
    },
  });
}

function modelAnswer(text: string, contextTokens = 20) {
  const usage = { inputTokens: contextTokens - 10, outputTokens: 10 };
  return {
    text,
    response: { messages: [{ role: "assistant", content: text }] },
    usage,
    totalUsage: usage,
  };
}

/** A model turn that draws an image, then answers with `text`. */
function drawsImage(text: string) {
  spyOn(imageProvider as ImageProvider, "generate").mockResolvedValueOnce(
    new Uint8Array([1, 2, 3]),
  );
  return async ({ tools }: { tools: ToolSet }) => {
    await tools.generateImage.execute?.({ prompt: "a fox" }, {
      toolCallId: "1",
      messages: [],
    } as ToolExecutionOptions);
    return modelAnswer(text);
  };
}

function payloadsOf(method: string) {
  return calls.filter((call) => call.method === method).map((c) => c.payload);
}

describe("handleMessage", () => {
  test("replies to the message with the answer as HTML", async () => {
    const chatId = uniqueChatId();
    generateText.mockResolvedValueOnce(modelAnswer("**hello**"));

    await handleMessage(gCommand(chatId, "hi"));

    expect(payloadsOf("sendMessage")).toMatchObject([
      {
        chat_id: chatId,
        text: "<b>hello</b>",
        parse_mode: "HTML",
        reply_parameters: { message_id: 1, allow_sending_without_reply: true },
      },
    ]);
  });

  test("resends the answer as plain text when Telegram rejects the HTML", async () => {
    failCall = ({ payload }) =>
      payload.parse_mode === "HTML"
        ? "Bad Request: can't parse entities: Unmatched end tag"
        : undefined;
    generateText.mockResolvedValueOnce(modelAnswer("~~old **price~~ new**"));

    await handleMessage(gCommand(uniqueChatId(), "hi"));

    const [, plain] = payloadsOf("sendMessage");
    expect(plain).toMatchObject({
      text: "~~old **price~~ new**",
      reply_parameters: { message_id: 1 },
    });
    expect(plain.parse_mode).toBeUndefined();
  });

  test("collapses a long answer into an expandable blockquote", async () => {
    generateText.mockResolvedValueOnce(
      modelAnswer(`**Summary**\n\n${"word ".repeat(250)}`),
    );

    await handleMessage(gCommand(uniqueChatId(), "hi"));

    const [{ text, parse_mode }] = payloadsOf("sendMessage");
    expect(parse_mode).toBe("HTML");
    expect(text).toStartWith("<blockquote expandable><b>Summary</b>\n\nword");
    expect(text).toEndWith("word</blockquote>");
  });

  test("collapses every message of an answer split in parts", async () => {
    generateText.mockResolvedValueOnce(modelAnswer("word ".repeat(1_000)));

    await handleMessage(gCommand(uniqueChatId(), "hi"));

    const texts = payloadsOf("sendMessage").map((payload) => payload.text);
    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(text).toStartWith("<blockquote expandable>");
      expect(text).toEndWith("</blockquote>");
    }
  });

  test("keeps a collapsed answer collapsed when Telegram rejects the HTML", async () => {
    failCall = ({ payload }) =>
      String(payload.text).includes("<s>")
        ? "Bad Request: can't parse entities: Unmatched end tag"
        : undefined;
    const answer = `~~old **price~~ new** <3 ${"word ".repeat(250)}`.trim();
    generateText.mockResolvedValueOnce(modelAnswer(answer));

    await handleMessage(gCommand(uniqueChatId(), "hi"));

    const [, fallback] = payloadsOf("sendMessage");
    expect(fallback).toMatchObject({
      text: `<blockquote expandable>${answer.replace("<", "&lt;")}</blockquote>`,
      parse_mode: "HTML",
    });
  });

  test("tells the chat when no answer could be generated", async () => {
    generateText.mockRejectedValueOnce(new Error("rate limited"));

    await handleMessage(gCommand(uniqueChatId(), "hi"));

    expect(payloadsOf("sendMessage")).toMatchObject([
      {
        text: "Couldn't generate a response\n<blockquote expandable>rate limited</blockquote>",
        parse_mode: "HTML",
      },
    ]);
  });

  test("escapes the error and clips it to fit one message", async () => {
    generateText.mockRejectedValueOnce(
      new Error(`Request too large for <model> ${"x".repeat(5_000)}`),
    );

    await handleMessage(gCommand(uniqueChatId(), "hi"));

    const [{ text }] = payloadsOf("sendMessage");
    expect(text).toStartWith(
      "Couldn't generate a response\n<blockquote expandable>Request too large for &lt;model&gt; x",
    );
    expect(text).toEndWith("x…</blockquote>");
    const visible = (text as string)
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;|&gt;/g, "<");
    expect(visible).toHaveLength(4096);
  });

  test("doesn't blame the model when the answer can't be delivered", async () => {
    failCall = ({ method }) =>
      method === "sendMessage" ? "Bad Request: chat not found" : undefined;
    generateText.mockResolvedValueOnce(modelAnswer("hello"));

    await expect(handleMessage(gCommand(uniqueChatId(), "hi"))).rejects.toThrow(
      "chat not found",
    );
    expect(payloadsOf("sendMessage")).toMatchObject([{ text: "hello" }]);
  });

  test("replies with the image before the answer", async () => {
    generateText.mockImplementationOnce(drawsImage("Here's your fox"));

    await handleMessage(gCommand(uniqueChatId(), "draw a fox"));

    const replies = calls.filter(({ method }) => method !== "sendChatAction");
    expect(replies).toMatchObject([
      {
        method: "sendPhoto",
        payload: {
          photo: expect.any(InputFile),
          reply_parameters: { message_id: 1 },
        },
      },
      { method: "sendMessage", payload: { text: "Here's your fox" } },
    ]);
  });

  test("sends only the image when the model adds nothing", async () => {
    generateText.mockImplementationOnce(drawsImage(""));

    await handleMessage(gCommand(uniqueChatId(), "draw a fox"));

    expect(payloadsOf("sendPhoto")).toHaveLength(1);
    expect(payloadsOf("sendMessage")).toEqual([]);
  });

  test("edits the photo the user replies to, at a size the provider takes", async () => {
    const chat = { id: uniqueChatId(), type: "group", title: "Test" } as const;
    const ctx = contextFor<Filter<Context, "message">>({
      message: {
        message_id: 2,
        date: 0,
        chat,
        from: SAM,
        text: "/g make it blue",
        entities: [{ type: "bot_command", offset: 0, length: 2 }],
        reply_to_message: {
          message_id: 1,
          date: 0,
          chat,
          photo: [90, 320, 1280].map((width) => ({
            file_id: `photo-${width}`,
            file_unique_id: "photo",
            width,
            height: (width * 3) / 4,
          })),
          reply_to_message: undefined,
        },
      },
    });
    const generate = spyOn(
      imageProvider as ImageProvider,
      "generate",
    ).mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
    const download = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(new Uint8Array([8])))
      .mockResolvedValueOnce(new Response(new Uint8Array([9])));
    generateText.mockImplementationOnce(
      async ({ tools }: { tools: ToolSet }) => {
        await tools.editImage.execute?.({ prompt: "make it blue" }, {
          toolCallId: "1",
          messages: [],
        } as ToolExecutionOptions);
        return modelAnswer("");
      },
    );

    try {
      await handleMessage(ctx);
    } finally {
      download.mockRestore();
    }

    expect(payloadsOf("getFile")).toEqual([
      { file_id: "photo-1280" },
      { file_id: "photo-320" },
    ]);
    expect(generate).toHaveBeenLastCalledWith({
      prompt: "make it blue",
      inputs: [Buffer.from([9])],
    });
    expect(payloadsOf("sendPhoto")).toHaveLength(1);
  });

  test("announces an automatic compaction after the answer", async () => {
    generateText
      .mockResolvedValueOnce(modelAnswer("hello", 1200))
      .mockResolvedValueOnce(modelAnswer("the summary", 950));

    await handleMessage(gCommand(uniqueChatId(), "hi"));

    expect(payloadsOf("sendMessage").map((payload) => payload.text)).toEqual([
      "hello",
      "Compacted conversation history (~1200 → ~10 tokens). Earlier messages are now a summary.",
    ]);
  });
});

describe("handleGuestMessage", () => {
  test("claims every reply at once, but answers one mention at a time", async () => {
    const chatId = uniqueChatId();
    const first = Promise.withResolvers<unknown>();
    generateText
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(modelAnswer("second"));

    const handled = Promise.all([
      handleGuestMessage(guestMention(chatId, 1)),
      handleGuestMessage(guestMention(chatId, 2)),
    ]);
    await Bun.sleep(0);

    expect(payloadsOf("answerGuestQuery")).toHaveLength(2);
    expect(generateText).toHaveBeenCalledTimes(1);

    first.resolve(modelAnswer("first"));
    await handled;

    expect(payloadsOf("editMessageText")).toMatchObject([
      { inline_message_id: "inline", text: "first", parse_mode: "HTML" },
      { inline_message_id: "inline", text: "second", parse_mode: "HTML" },
    ]);
  });

  test("turns the placeholder into the image, with the answer as its caption", async () => {
    generateText.mockImplementationOnce(drawsImage("Here's your fox"));

    await handleGuestMessage(guestMention(uniqueChatId(), 1, "draw a fox"));

    const replies = calls.filter(({ method }) => method !== "answerGuestQuery");
    expect(replies).toMatchObject([
      {
        method: "sendPhoto",
        payload: {
          chat_id: "-100",
          photo: expect.any(InputFile),
          disable_notification: true,
        },
      },
      {
        method: "editMessageMedia",
        payload: {
          inline_message_id: "inline",
          media: { type: "photo", media: "large" },
        },
      },
      { method: "deleteMessage", payload: { chat_id: "-100", message_id: 99 } },
      {
        method: "editMessageCaption",
        payload: { inline_message_id: "inline", caption: "Here's your fox" },
      },
    ]);
  });

  test("keeps the image when the upload chat can't be cleaned up", async () => {
    failCall = ({ method }) =>
      method === "deleteMessage" ? "Bad Request: not enough rights" : undefined;
    generateText.mockImplementationOnce(drawsImage("Here's your fox"));

    await handleGuestMessage(guestMention(uniqueChatId(), 1, "draw a fox"));

    expect(payloadsOf("editMessageMedia")).toHaveLength(1);
    expect(payloadsOf("editMessageCaption")).toMatchObject([
      { caption: "Here's your fox" },
    ]);
  });

  test("cuts a caption longer than Telegram allows short", async () => {
    generateText.mockImplementationOnce(drawsImage("word ".repeat(400)));

    await handleGuestMessage(guestMention(uniqueChatId(), 1, "draw a fox"));

    const [{ caption }] = payloadsOf("editMessageCaption");
    const visible = (caption as string).replace(/<[^>]+>/g, "");
    expect(visible.length).toBeLessThanOrEqual(1024);
    expect(caption).toEndWith("\n…</blockquote>");
  });

  test("can't draw images without an upload chat", async () => {
    const uploadChatId = config.TELEGRAM_UPLOAD_CHAT_ID;
    config.TELEGRAM_UPLOAD_CHAT_ID = undefined;
    generateText.mockResolvedValueOnce(modelAnswer("hello"));

    try {
      await handleGuestMessage(guestMention(uniqueChatId(), 1, "draw a fox"));
    } finally {
      config.TELEGRAM_UPLOAD_CHAT_ID = uploadChatId;
    }

    const [[request]] = generateText.mock.calls;
    expect(Object.keys(request.tools)).not.toContain("generateImage");
  });

  test("shows the error in place of the placeholder", async () => {
    generateText.mockRejectedValueOnce(new Error("rate limited"));

    await handleGuestMessage(guestMention(uniqueChatId(), 1));

    expect(payloadsOf("editMessageText")).toMatchObject([
      {
        inline_message_id: "inline",
        text: "Couldn't generate a response\n<blockquote expandable>rate limited</blockquote>",
        parse_mode: "HTML",
      },
    ]);
  });

  test("cuts an answer longer than one message short", async () => {
    generateText.mockResolvedValueOnce(modelAnswer("word ".repeat(1_000)));

    await handleGuestMessage(guestMention(uniqueChatId(), 1));

    const [{ text }] = payloadsOf("editMessageText");
    const visible = (text as string).replace(/<[^>]+>/g, "");
    expect(visible.length).toBeLessThanOrEqual(4096);
    expect(text).toStartWith("<blockquote expandable>");
    expect(text).toEndWith("\n…</blockquote>");
  });

  test("compacts the history on `@MyBot /compact`", async () => {
    const chatId = uniqueChatId();
    updateChat(chatId, (chat) => {
      chat.history.push({ role: "user", content: "hello" });
      chat.lastContextTokens = 1200;
    });
    generateText.mockResolvedValueOnce(modelAnswer("the summary", 950));

    await handleGuestMessage(guestMention(chatId, 1, "/compact"));

    expect(generateText.mock.calls[0][0].prompt).toContain("hello");
    expect(payloadsOf("editMessageText")).toMatchObject([
      {
        inline_message_id: "inline",
        text: "Compacted conversation history (~1200 → ~10 tokens). Earlier messages are now a summary.",
      },
    ]);
  });

  test("answers `@MyBot /whichmodel` without the model", async () => {
    await handleGuestMessage(guestMention(uniqueChatId(), 1, "/whichmodel"));

    expect(generateText).not.toHaveBeenCalled();
    expect(payloadsOf("editMessageText")).toMatchObject([
      { text: "<code>default-model</code>" },
    ]);
  });

  test("clears the history on `@MyBot /newchat`", async () => {
    const chatId = uniqueChatId();
    updateChat(chatId, (chat) => {
      chat.history.push({ role: "user", content: "hello" });
    });

    await handleGuestMessage(guestMention(chatId, 1, "/newchat"));

    expect(getChat(chatId).history).toEqual([]);
    expect(payloadsOf("editMessageText")).toMatchObject([
      { text: "Chat history cleared." },
    ]);
  });

  test("sends unknown commands to the model", async () => {
    generateText.mockResolvedValueOnce(modelAnswer("no idea"));

    await handleGuestMessage(guestMention(uniqueChatId(), 1, "/whatever"));

    expect(generateText).toHaveBeenCalledTimes(1);
  });

  test("says when there's nothing to compact", async () => {
    await handleGuestMessage(guestMention(uniqueChatId(), 1, "/compact"));

    expect(generateText).not.toHaveBeenCalled();
    expect(payloadsOf("editMessageText")).toMatchObject([
      { text: "Nothing to compact." },
    ]);
  });
});
