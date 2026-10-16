import { createGroq } from "@ai-sdk/groq";
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
import { MAX_TOOL_CHARS, truncate } from "./transcript";
import { webSearchTool } from "./web-search";

const groq = createGroq({ apiKey: config.GROQ_API_KEY });

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

export function getModelId(chatId: number): string {
  return getChat(chatId).modelId ?? config.GROQ_DEFAULT_MODEL_ID;
}

export function getModel(chatId: number) {
  return groq(getModelId(chatId));
}

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
  const log = logger.child({ chatId, modelId: getModelId(chatId) });

  const result = await generateText({
    model: getModel(chatId),
    system: buildSystemPrompt(summary),
    messages: [...history, userMessage],
    tools: { googleSearch: webSearchTool },
    stopWhen: stepCountIs(5),
    onStepFinish: (step) =>
      log.info("model.step", {
        finishReason: step.finishReason,
        rawFinishReason: step.rawFinishReason,
        toolCalls: step.toolCalls.map((call) => call.toolName),
        usage: step.usage,
        text: step.text,
      }),
  });

  log.info("model.replied", {
    finishReason: result.finishReason,
    rawFinishReason: result.rawFinishReason,
    usage: result.usage,
    chars: result.text.length,
    text: result.text,
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
