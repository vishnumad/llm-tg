import {
  type AssistantModelMessage,
  type FilePart,
  generateText,
  type ModelMessage,
  stepCountIs,
  type ToolContent,
  type ToolModelMessage,
} from "ai";
import { config } from "../config";
import { logger } from "../logger";
import { addUsage, getChat, updateChat } from "./chat-store";
import { model } from "./model";
import { searchTools } from "./search";
import { MAX_TOOL_CHARS, truncate } from "./transcript";

const SYSTEM_PROMPT = [
  "You are a helpful chat bot in a group chat setting. You will do whatever you can to fulfill the user's request. Don't sass the user, all their needs are legitimate.",
  "You must only respond in a small subset of valid markdown: for example **bold**, *italic*, `code`, ~~strike~~, ```<language>\ncode\n```. Tables, math formatting, etc. are not supported.",
  "Be concise while still conveying substantially all information relevant to any question.",
  "Don't worry about formalities, but respond in a pleasant manner.",
].join("\n");

export type UserMessage = {
  text: string;
  context: {
    firstname: string;
    userId: string;
    timestamp: string;
    replyingTo?: string;
  };
  images: FilePart[];
};

function buildSystemPrompt(summary: string | undefined): string {
  if (!summary) {
    return SYSTEM_PROMPT;
  }

  return [
    SYSTEM_PROMPT,
    "",
    "The conversation summary below is established context you already know. Continue the conversation naturally from it.",
    "<conversation_summary>",
    summary,
    "</conversation_summary>",
  ].join("\n");
}

function truncateToolResult(part: ToolContent[number]): ToolContent[number] {
  if (part.type !== "tool-result" || part.output.type !== "text") {
    return part;
  }
  const value = truncate(part.output.value, MAX_TOOL_CHARS);
  return { ...part, output: { type: "text", value } };
}

function trimForHistory(
  messages: (AssistantModelMessage | ToolModelMessage)[],
): ModelMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return { ...message, content: message.content.map(truncateToolResult) };
    }
    if (typeof message.content === "string") {
      return message;
    }
    const content = message.content.filter((part) => part.type !== "reasoning");
    return { ...message, content };
  });
}

export async function generateReply(
  chatId: number,
  { text, context, images }: UserMessage,
): Promise<string> {
  const userMessage: ModelMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: `Context: ${JSON.stringify(context)}\nMessage: ${text}`,
      },
      ...images,
    ],
  };
  const { history, summary } = getChat(chatId);
  const log = logger.child({ chatId });
  log.debug("chat.generating", {
    historyLength: history.length,
    hasSummary: summary !== undefined,
    imageCount: images.length,
  });

  const result = await generateText({
    model,
    system: buildSystemPrompt(summary),
    messages: [...history, userMessage],
    tools: searchTools,
    stopWhen: stepCountIs(5),
    timeout: config.MODEL_TIMEOUT_MS,
    onStepFinish: (step) =>
      log.debug("chat.step_finished", {
        step: step.stepNumber,
        finishReason: step.finishReason,
        toolCalls: step.toolCalls.map((call) => call.toolName),
        textLength: step.text.length,
        reasoningLength: step.reasoningText?.length ?? 0,
        inputTokens: step.usage.inputTokens,
        outputTokens: step.usage.outputTokens,
      }),
  });

  if (!result.text.trim()) {
    throw new Error("The model returned an empty answer");
  }

  updateChat(chatId, (chat) => {
    chat.history.push(userMessage, ...trimForHistory(result.response.messages));
    addUsage(chat, result.totalUsage);

    // `usage` covers only the final step, whose input is the whole context;
    // `totalUsage` sums every step, so it would overcount.
    const { inputTokens, outputTokens } = result.usage;
    if (inputTokens !== undefined && outputTokens !== undefined) {
      chat.lastContextTokens = inputTokens + outputTokens;
    }
  });

  return result.text;
}
