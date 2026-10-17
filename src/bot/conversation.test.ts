import { beforeEach, describe, expect, test } from "bun:test";
import { Api, Context, type Filter } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { getChat, updateChat } from "../ai/chat-store";
import { generateText, uniqueChatId } from "../test-setup";
import { handleGuestMessage, handleMessage } from "./conversation";

type ApiCall = { method: string; payload: Record<string, unknown> };

const BOT = { id: 42, is_bot: true, first_name: "MyBot", username: "MyBot" };
const SAM = { id: 7, is_bot: false, first_name: "Sam" };

let calls: ApiCall[];
/** Turns a call into a Telegram error by returning its description. */
let failCall: (call: ApiCall) => string | undefined;

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
        result:
          method === "answerGuestQuery"
            ? { inline_message_id: "inline" }
            : true,
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

  test("runs other commands too, such as `@MyBot /switchmodel`", async () => {
    const chatId = uniqueChatId();

    await handleGuestMessage(
      guestMention(chatId, 1, "/switchmodel chosen-model"),
    );
    await handleGuestMessage(guestMention(chatId, 2, "/whichmodel"));

    expect(generateText).not.toHaveBeenCalled();
    expect(payloadsOf("editMessageText")).toMatchObject([
      { text: "Model set to <code>chosen-model</code>" },
      { text: "<code>chosen-model</code>" },
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
