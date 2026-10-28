import { beforeEach, describe, expect, test } from "bun:test";
import { Api, Context, type Filter } from "grammy";
import type { Chat, Update, UserFromGetMe } from "grammy/types";
import { getChat, updateChat } from "../ai/chat-store";
import {
  type FakeStream,
  fakeStream,
  generateText,
  streamText,
  uniqueChatId,
} from "../test-setup";
import { handleGuestMessage, handleMessage } from "./conversation";
import { handleStopGeneration } from "./stop";

type ApiCall = { method: string; payload: Record<string, unknown> };

const BOT = { id: 42, is_bot: true, first_name: "MyBot", username: "MyBot" };
const SAM = { id: 7, is_bot: false, first_name: "Sam" };

let calls: ApiCall[];
/** Turns a call into a Telegram error by returning its description. */
let failCall: (call: ApiCall) => string | undefined;
let lastMessageId: number;

function resultOf(method: string) {
  if (method === "answerGuestQuery") {
    return { inline_message_id: "inline" };
  }
  if (method === "sendMessage") {
    lastMessageId += 1;
    return { message_id: lastMessageId };
  }
  return true;
}

// Records every Telegram call instead of sending it.
const api = new Api("test");
api.config.use(async (_prev, method, payload) => {
  const call = { method, payload: payload as Record<string, unknown> };
  calls.push(call);
  const description = failCall(call);
  const response = description
    ? { ok: false, error_code: 400, description }
    : { ok: true, result: resultOf(method) };
  return response as never;
});

beforeEach(() => {
  calls = [];
  failCall = () => undefined;
  lastMessageId = 100;
  generateText.mockReset();
  streamText.mockReset();
});

function contextFor<C extends Context>(update: Omit<Update, "update_id">) {
  return new Context(
    { update_id: 1, ...update },
    api,
    BOT as UserFromGetMe,
  ) as C;
}

function gCommand(chatId: number, prompt: string, type = "group") {
  const chat =
    type === "private"
      ? { id: chatId, type: "private", first_name: "Sam" }
      : { id: chatId, type: "group", title: "Test" };
  return contextFor<Filter<Context, "message">>({
    message: {
      message_id: 1,
      date: 0,
      chat: chat as Chat.GroupChat,
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

function stopPressed(chatId: number, draftId: number) {
  return contextFor<Filter<Context, "stopped_message_generation">>({
    stopped_message_generation: {
      chat: { id: chatId, type: "private", first_name: "Sam" },
      draft_id: draftId,
    },
  });
}

/** The model streams `text` in one go, or fails with `error` after it. */
function modelAnswers(text: string, options: FakeStream = {}) {
  streamText.mockImplementationOnce(
    fakeStream({ steps: [text ? [text] : []], ...options }),
  );
}

function modelFails(message: string, text = "") {
  modelAnswers(text, { error: new Error(message) });
}

/** A compaction summary, which still comes from a single model call. */
function summaryAnswer(text: string, contextTokens: number) {
  const usage = { inputTokens: contextTokens - 10, outputTokens: 10 };
  return { text, usage, totalUsage: usage };
}

function payloadsOf(method: string) {
  return calls.filter((call) => call.method === method).map((c) => c.payload);
}

describe("handleMessage in a group", () => {
  test("replies to the message with the answer as HTML", async () => {
    const chatId = uniqueChatId();
    modelAnswers("**hello**");

    await handleMessage(gCommand(chatId, "hi"));

    expect(payloadsOf("sendMessage")).toMatchObject([
      {
        chat_id: chatId,
        text: "<b>hello</b>",
        parse_mode: "HTML",
        reply_parameters: { message_id: 1, allow_sending_without_reply: true },
      },
    ]);
    // The preview already shows the finished answer.
    expect(payloadsOf("editMessageText")).toEqual([]);
  });

  test("edits the answer in as it streams", async () => {
    const chatId = uniqueChatId();
    const done = Promise.withResolvers<void>();
    streamText.mockImplementationOnce(
      fakeStream({ steps: [["Hel", "lo"]], gate: done.promise }),
    );

    const handled = handleMessage(gCommand(chatId, "hi"));
    await Bun.sleep(0);
    expect(payloadsOf("sendMessage")).toMatchObject([{ text: "Hel" }]);

    done.resolve();
    await handled;
    expect(payloadsOf("editMessageText")).toMatchObject([
      { chat_id: chatId, message_id: 101, text: "Hello", parse_mode: "HTML" },
    ]);
  });

  test("closes a code block the model is still writing", async () => {
    const done = Promise.withResolvers<void>();
    streamText.mockImplementationOnce(
      fakeStream({ steps: [["```js\nconst a = 1;"]], gate: done.promise }),
    );

    const handled = handleMessage(gCommand(uniqueChatId(), "hi"));
    await Bun.sleep(0);
    done.resolve();
    await handled;

    expect(payloadsOf("sendMessage")).toMatchObject([
      { text: "<pre><code>const a = 1;\n</code></pre>" },
    ]);
  });

  test("resends the answer as plain text when Telegram rejects the HTML", async () => {
    failCall = ({ payload }) =>
      payload.parse_mode === "HTML"
        ? "Bad Request: can't parse entities: Unmatched end tag"
        : undefined;
    modelAnswers("~~old **price~~ new**");

    await handleMessage(gCommand(uniqueChatId(), "hi"));

    const [, plain] = payloadsOf("sendMessage");
    expect(plain).toMatchObject({
      text: "~~old **price~~ new**",
      reply_parameters: { message_id: 1 },
    });
    expect(plain.parse_mode).toBeUndefined();
  });

  test("collapses a long answer into an expandable blockquote once done", async () => {
    modelAnswers(`**Summary**\n\n${"word ".repeat(250)}`);

    await handleMessage(gCommand(uniqueChatId(), "hi"));

    const [preview] = payloadsOf("sendMessage");
    expect(preview.text).toStartWith("<b>Summary</b>");
    const [{ text, parse_mode }] = payloadsOf("editMessageText");
    expect(parse_mode).toBe("HTML");
    expect(text).toStartWith("<blockquote expandable><b>Summary</b>\n\nword");
    expect(text).toEndWith("word</blockquote>");
  });

  test("spills a long answer into more messages, all collapsed", async () => {
    modelAnswers("word ".repeat(1_000));

    await handleMessage(gCommand(uniqueChatId(), "hi"));

    const sent = payloadsOf("sendMessage");
    expect(sent).toHaveLength(2);
    expect(sent[0].reply_parameters).toMatchObject({ message_id: 1 });
    expect(sent[1].reply_parameters).toBeUndefined();
    const edits = payloadsOf("editMessageText");
    expect(edits.map((edit) => edit.message_id)).toEqual([101, 102]);
    for (const { text } of edits) {
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
    modelAnswers(answer);

    await handleMessage(gCommand(uniqueChatId(), "hi"));

    const [, fallback] = payloadsOf("editMessageText");
    expect(fallback).toMatchObject({
      text: `<blockquote expandable>${answer.replace("<", "&lt;")}</blockquote>`,
      parse_mode: "HTML",
    });
  });

  test("tells the chat when no answer could be generated", async () => {
    modelFails("rate limited");

    await handleMessage(gCommand(uniqueChatId(), "hi"));

    expect(payloadsOf("sendMessage")).toMatchObject([
      {
        text: "Couldn't generate a response\n<blockquote expandable>rate limited</blockquote>",
        parse_mode: "HTML",
      },
    ]);
  });

  test("replaces a partial answer with the error", async () => {
    modelFails("connection reset", "Half an ans");

    await handleMessage(gCommand(uniqueChatId(), "hi"));

    expect(payloadsOf("sendMessage")).toMatchObject([{ text: "Half an ans" }]);
    expect(payloadsOf("editMessageText")).toMatchObject([
      {
        message_id: 101,
        text: "Couldn't generate a response\n<blockquote expandable>connection reset</blockquote>",
      },
    ]);
  });

  test("escapes the error and clips it to fit one message", async () => {
    modelFails(`Request too large for <model> ${"x".repeat(5_000)}`);

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
    modelAnswers("hello");

    await expect(handleMessage(gCommand(uniqueChatId(), "hi"))).rejects.toThrow(
      "chat not found",
    );
    // Once as the preview, which fails quietly, then as the answer.
    expect(payloadsOf("sendMessage")).toMatchObject([
      { text: "hello" },
      { text: "hello" },
    ]);
  });

  test("announces an automatic compaction after the answer", async () => {
    modelAnswers("hello", { usage: { inputTokens: 1190, outputTokens: 10 } });
    generateText.mockResolvedValueOnce(summaryAnswer("the summary", 950));

    await handleMessage(gCommand(uniqueChatId(), "hi"));

    expect(payloadsOf("sendMessage").map((payload) => payload.text)).toEqual([
      "hello",
      "Compacted conversation history (~1200 → ~10 tokens). Earlier messages are now a summary.",
    ]);
  });
});

describe("handleMessage in a private chat", () => {
  test("streams the answer as a draft, then sends it", async () => {
    const chatId = uniqueChatId();
    modelAnswers("**hello**");

    await handleMessage(gCommand(chatId, "hi", "private"));

    expect(payloadsOf("sendMessageDraft")).toMatchObject([
      {
        chat_id: chatId,
        draft_id: 1,
        text: "<b>hello</b>",
        parse_mode: "HTML",
        can_stop: true,
        keep_on_stop: true,
      },
    ]);
    expect(payloadsOf("sendMessage")).toMatchObject([
      { text: "<b>hello</b>", reply_parameters: { message_id: 1 } },
    ]);
  });

  test("keeps what was written when the user presses stop", async () => {
    const chatId = uniqueChatId();
    const pressed = Promise.withResolvers<void>();
    modelAnswers("Once upon", { gate: pressed.promise });

    const handled = handleMessage(gCommand(chatId, "hi", "private"));
    await Bun.sleep(0);
    handleStopGeneration(stopPressed(chatId, 1));
    pressed.resolve();
    await handled;

    expect(streamText.mock.calls[0][0].abortSignal.aborted).toBe(true);
    expect(payloadsOf("sendMessage")).toMatchObject([{ text: "Once upon" }]);
    expect(getChat(chatId).history[1]).toEqual({
      role: "assistant",
      content: "Once upon",
    });
  });

  test("ignores a stop for an answer that already finished", async () => {
    const chatId = uniqueChatId();
    modelAnswers("done");
    await handleMessage(gCommand(chatId, "hi", "private"));

    handleStopGeneration(stopPressed(chatId, 1));

    expect(streamText.mock.calls[0][0].abortSignal.aborted).toBe(false);
  });
});

describe("handleGuestMessage", () => {
  test("claims every reply at once, but answers one mention at a time", async () => {
    const chatId = uniqueChatId();
    const first = Promise.withResolvers<void>();
    modelAnswers("first", { gate: first.promise });
    modelAnswers("second");

    const handled = Promise.all([
      handleGuestMessage(guestMention(chatId, 1)),
      handleGuestMessage(guestMention(chatId, 2)),
    ]);
    await Bun.sleep(0);

    expect(payloadsOf("answerGuestQuery")).toHaveLength(2);
    expect(streamText).toHaveBeenCalledTimes(1);

    first.resolve();
    await handled;

    expect(payloadsOf("editMessageText")).toMatchObject([
      { inline_message_id: "inline", text: "first", parse_mode: "HTML" },
      { inline_message_id: "inline", text: "second", parse_mode: "HTML" },
    ]);
  });

  test("shows the error in place of the placeholder", async () => {
    modelFails("rate limited");

    await handleGuestMessage(guestMention(uniqueChatId(), 1));

    expect(payloadsOf("editMessageText")).toMatchObject([
      {
        inline_message_id: "inline",
        text: "Couldn't generate a response\n<blockquote expandable>rate limited</blockquote>",
        parse_mode: "HTML",
      },
    ]);
  });

  test("shows the error in place of a partial answer", async () => {
    modelFails("connection reset", "Half an ans");

    await handleGuestMessage(guestMention(uniqueChatId(), 1));

    expect(payloadsOf("editMessageText")).toMatchObject([
      { text: "Half an ans" },
      {
        text: "Couldn't generate a response\n<blockquote expandable>connection reset</blockquote>",
      },
    ]);
  });

  test("cuts an answer longer than one message short", async () => {
    modelAnswers("word ".repeat(1_000));

    await handleGuestMessage(guestMention(uniqueChatId(), 1));

    const { text } = payloadsOf("editMessageText").at(-1) ?? {};
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
    generateText.mockResolvedValueOnce(summaryAnswer("the summary", 950));

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

    expect(streamText).not.toHaveBeenCalled();
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
    modelAnswers("no idea");

    await handleGuestMessage(guestMention(uniqueChatId(), 1, "/whatever"));

    expect(streamText).toHaveBeenCalledTimes(1);
  });

  test("says when there's nothing to compact", async () => {
    await handleGuestMessage(guestMention(uniqueChatId(), 1, "/compact"));

    expect(generateText).not.toHaveBeenCalled();
    expect(payloadsOf("editMessageText")).toMatchObject([
      { text: "Nothing to compact." },
    ]);
  });
});

// Last, as turning drafts down is remembered for the rest of the process.
describe("handleMessage when Telegram turns drafts down", () => {
  test("falls back to editing a message, now and for later turns", async () => {
    failCall = ({ method }) =>
      method === "sendMessageDraft"
        ? "Bad Request: method is not available"
        : undefined;
    modelAnswers("hello");
    modelAnswers("again");

    await handleMessage(gCommand(uniqueChatId(), "hi", "private"));
    await handleMessage(gCommand(uniqueChatId(), "hi", "private"));

    expect(payloadsOf("sendMessageDraft")).toHaveLength(1);
    expect(payloadsOf("sendMessage")).toMatchObject([
      { text: "hello", reply_parameters: { message_id: 1 } },
      { text: "again", reply_parameters: { message_id: 1 } },
    ]);
  });
});
