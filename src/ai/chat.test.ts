import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ModelMessage, ToolExecutionOptions, ToolSet } from "ai";
import { generateText, uniqueChatId } from "../test-setup";
import { generateReply, type UserMessage } from "./chat";
import { getChat, updateChat } from "./chat-store";
import { imageProvider } from "./image";
import type { ImageProvider } from "./image/provider";

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

  test("offers image generation only when the reply can send images", async () => {
    const answer = {
      text: "Hi!",
      response: { messages: [reply] },
      usage: { inputTokens: 1, outputTokens: 1 },
      totalUsage: { inputTokens: 1, outputTokens: 1 },
    };
    generateText.mockResolvedValue(answer);

    await generateReply(uniqueChatId(), message);
    await generateReply(uniqueChatId(), message, async () => {});

    const [withoutImages, withImages] = generateText.mock.calls.map(
      ([request]) => Object.keys(request.tools),
    );
    expect(withoutImages).not.toContain("generateImage");
    expect(withImages).toContain("generateImage");
  });

  test("accepts an empty answer once the model has sent an image", async () => {
    const chatId = uniqueChatId();
    const image = new Uint8Array([1, 2, 3]);
    spyOn(imageProvider as ImageProvider, "generate").mockResolvedValueOnce(
      image,
    );
    const sendImage = mock(async () => {});
    generateText.mockImplementationOnce(
      async ({ tools }: { tools: ToolSet }) => {
        await tools.generateImage.execute?.({ prompt: "a fox" }, {
          toolCallId: "1",
          messages: [],
        } as ToolExecutionOptions);
        return {
          text: "",
          response: { messages: [reply] },
          usage: { inputTokens: 1, outputTokens: 1 },
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    );

    expect(await generateReply(chatId, message, sendImage)).toBe("");
    expect(sendImage).toHaveBeenCalledWith(image);
    expect(getChat(chatId).history).toHaveLength(2);
  });
});
