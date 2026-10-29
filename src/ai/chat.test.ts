import { beforeEach, describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { fakeStream, streamText, uniqueChatId } from "../test-setup";
import { generateReply, type UserMessage } from "./chat";
import { getChat, updateChat } from "./chat-store";

const message: UserMessage = {
  text: "hello",
  context: { firstname: "Sam", userId: "7", timestamp: "now" },
  images: [],
};

const reply: ModelMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Hi!" }],
};

beforeEach(() => streamText.mockReset());

describe("generateReply", () => {
  test("appends the turn to history and records usage", async () => {
    const chatId = uniqueChatId();
    streamText.mockImplementationOnce(
      fakeStream({
        response: { messages: [reply] },
        usage: { inputTokens: 300, outputTokens: 20 },
        totalUsage: { inputTokens: 500, outputTokens: 40 },
      }),
    );

    expect(await generateReply(chatId, message)).toEqual({
      text: "Hi!",
      stopped: false,
    });

    const chat = getChat(chatId);
    expect(chat.history).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: 'Context: {"firstname":"Sam","userId":"7","timestamp":"now"}\nMessage: hello',
          },
        ],
      },
      reply,
    ]);
    expect(chat.tokenUsage).toEqual({
      totalInputTokens: 500,
      totalOutputTokens: 40,
    });
    // The final step alone, not the sum across tool-call steps.
    expect(chat.lastContextTokens).toBe(320);
  });

  test("keeps reasoning and long tool results out of history", async () => {
    const chatId = uniqueChatId();
    const toolCall = {
      type: "tool-call",
      toolCallId: "1",
      toolName: "webSearch",
      input: { query: "bun" },
    } as const;
    const toolResult = {
      type: "tool-result",
      toolCallId: "1",
      toolName: "webSearch",
    } as const;
    streamText.mockImplementationOnce(
      fakeStream({
        response: {
          messages: [
            {
              role: "assistant",
              content: [{ type: "reasoning", text: "let me search" }, toolCall],
            },
            {
              role: "tool",
              content: [
                {
                  ...toolResult,
                  output: { type: "text", value: "x".repeat(5_000) },
                },
              ],
            },
            {
              role: "assistant",
              content: [
                { type: "reasoning", text: "got it" },
                ...reply.content,
              ],
            },
          ],
        },
      }),
    );

    await generateReply(chatId, message);

    expect(getChat(chatId).history.slice(1)).toEqual([
      { role: "assistant", content: [toolCall] },
      {
        role: "tool",
        content: [
          {
            ...toolResult,
            output: {
              type: "text",
              value: `${"x".repeat(2_000)}... [truncated]`,
            },
          },
        ],
      },
      reply,
    ]);
  });

  test("sends the configured model, the chat's summary and history", async () => {
    const chatId = uniqueChatId();
    const earlier: ModelMessage = { role: "user", content: "earlier" };
    updateChat(chatId, (chat) => {
      chat.history.push(earlier);
      chat.summary = "they like cats";
    });
    streamText.mockImplementationOnce(fakeStream());

    await generateReply(chatId, message);

    const request = streamText.mock.calls[0][0];
    expect(request.model.modelId).toBe("default-model");
    expect(request.system).toContain(
      "<conversation_summary>\nthey like cats\n</conversation_summary>",
    );
    expect(request.messages[0]).toEqual(earlier);
    expect(request.messages).toHaveLength(2);
  });

  test("streams the answer so far, starting over with each step", async () => {
    streamText.mockImplementationOnce(
      fakeStream({
        steps: [
          ["Let me ", "search"],
          ["It's ", "sunny"],
        ],
      }),
    );
    const seen: string[] = [];

    const { text } = await generateReply(uniqueChatId(), message, {
      onText: (text) => seen.push(text),
    });

    expect(seen).toEqual(["Let me ", "Let me search", "It's ", "It's sunny"]);
    expect(text).toBe("It's sunny");
  });

  test("leaves the chat untouched when the model call fails", async () => {
    const chatId = uniqueChatId();
    streamText.mockImplementationOnce(
      fakeStream({ error: new Error("rate limited") }),
    );

    await expect(generateReply(chatId, message)).rejects.toThrow(
      "rate limited",
    );
    expect(getChat(chatId).history).toEqual([]);
  });

  test("treats an empty answer as a failure, leaving the chat untouched", async () => {
    const chatId = uniqueChatId();
    streamText.mockImplementationOnce(fakeStream({ steps: [["  "]] }));

    await expect(generateReply(chatId, message)).rejects.toThrow(
      "empty answer",
    );
    expect(getChat(chatId).history).toEqual([]);
  });

  test("keeps a stopped answer's partial text in history", async () => {
    const chatId = uniqueChatId();
    const stop = new AbortController();
    const pressed = Promise.withResolvers<void>();
    streamText.mockImplementationOnce(
      fakeStream({ steps: [["Once upon"]], gate: pressed.promise }),
    );

    const replied = generateReply(chatId, message, {
      abortSignal: stop.signal,
    });
    stop.abort();
    pressed.resolve();

    expect(await replied).toEqual({ text: "Once upon", stopped: true });
    const chat = getChat(chatId);
    expect(chat.history[1]).toEqual({
      role: "assistant",
      content: "Once upon",
    });
    // A stopped turn reports no usage.
    expect(chat.tokenUsage.totalInputTokens).toBe(0);
  });

  test("leaves the chat untouched when stopped before any text", async () => {
    const chatId = uniqueChatId();
    const stop = new AbortController();
    stop.abort();
    streamText.mockImplementationOnce(fakeStream({ steps: [[]] }));

    expect(
      await generateReply(chatId, message, { abortSignal: stop.signal }),
    ).toEqual({ text: "", stopped: true });
    expect(getChat(chatId).history).toEqual([]);
  });

  test("treats an abort it didn't ask for, like a timeout, as a failure", async () => {
    const chatId = uniqueChatId();
    streamText.mockImplementationOnce(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "Once" };
        yield { type: "abort", reason: "The operation timed out." };
      })(),
    }));

    await expect(generateReply(chatId, message)).rejects.toThrow("timed out");
    expect(getChat(chatId).history).toEqual([]);
  });
});
