import { beforeEach, describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { generateText, uniqueChatId } from "../test-setup";
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

beforeEach(() => generateText.mockReset());

describe("generateReply", () => {
  test("appends the turn to history and records usage", async () => {
    const chatId = uniqueChatId();
    generateText.mockResolvedValueOnce({
      text: "Hi!",
      response: { messages: [reply] },
      usage: { inputTokens: 300, outputTokens: 20 },
      totalUsage: { inputTokens: 500, outputTokens: 40 },
    });

    expect(await generateReply(chatId, message)).toBe("Hi!");

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
    generateText.mockResolvedValueOnce({
      text: "Hi!",
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
            content: [{ type: "reasoning", text: "got it" }, ...reply.content],
          },
        ],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
      totalUsage: { inputTokens: 1, outputTokens: 1 },
    });

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
    generateText.mockResolvedValueOnce({
      text: "Hi!",
      response: { messages: [reply] },
      usage: { inputTokens: 1, outputTokens: 1 },
      totalUsage: { inputTokens: 1, outputTokens: 1 },
    });

    await generateReply(chatId, message);

    const request = generateText.mock.calls[0][0];
    expect(request.model.modelId).toBe("default-model");
    expect(request.system).toContain(
      "<conversation_summary>\nthey like cats\n</conversation_summary>",
    );
    expect(request.messages[0]).toEqual(earlier);
    expect(request.messages).toHaveLength(2);
  });

  test("leaves the chat untouched when the model call fails", async () => {
    const chatId = uniqueChatId();
    generateText.mockRejectedValueOnce(new Error("rate limited"));

    await expect(generateReply(chatId, message)).rejects.toThrow(
      "rate limited",
    );
    expect(getChat(chatId).history).toEqual([]);
  });

  test("treats an empty answer as a failure, leaving the chat untouched", async () => {
    const chatId = uniqueChatId();
    generateText.mockResolvedValueOnce({
      text: "  ",
      response: { messages: [reply] },
      usage: { inputTokens: 1, outputTokens: 1 },
      totalUsage: { inputTokens: 1, outputTokens: 1 },
    });

    await expect(generateReply(chatId, message)).rejects.toThrow(
      "empty answer",
    );
    expect(getChat(chatId).history).toEqual([]);
  });
});
