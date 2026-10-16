import { createGroq } from "@ai-sdk/groq";
import {
  type AssistantModelMessage,
  type FilePart,
  generateText,
  type ModelMessage,
  stepCountIs,
  type ToolModelMessage,
  type ToolResultPart,
} from "ai";
import { config } from "../config";
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

function truncateToolOutput(
  output: ToolResultPart["output"],
): ToolResultPart["output"] {
  switch (output.type) {
    case "text":
    case "error-text":
      return { ...output, value: truncate(output.value, MAX_TOOL_CHARS) };
    case "json":
    case "error-json": {
      const value = JSON.stringify(output.value);
      return value.length <= MAX_TOOL_CHARS
        ? output
        : {
            type: output.type === "json" ? "text" : "error-text",
            value: truncate(value, MAX_TOOL_CHARS),
          };
    }
    default:
      return output;
  }
}

/**
 * Shrink a turn's response messages before they join the history, which is
 * re-sent with every later request. Reasoning is dropped, as the model never
 * needs its old thinking, and tool results are truncated.
 */
export function toHistory(
  messages: (AssistantModelMessage | ToolModelMessage)[],
): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role === "tool") {
      const content = message.content.map((part) =>
        part.type === "tool-result"
          ? { ...part, output: truncateToolOutput(part.output) }
          : part,
      );
      return [{ ...message, content }];
    }

    if (typeof message.content === "string") {
      return [message];
    }
    const content = message.content.filter((part) => part.type !== "reasoning");
    return content.length > 0 ? [{ ...message, content }] : [];
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

  const result = await generateText({
    model: getModel(chatId),
    system: buildSystemPrompt(summary),
    messages: [...history, userMessage],
    tools: { googleSearch: webSearchTool },
    stopWhen: stepCountIs(5),
  });

  if (!result.text.trim()) {
    throw new Error("The model returned an empty answer");
  }

  updateChat(chatId, (chat) => {
    chat.history.push(userMessage, ...toHistory(result.response.messages));
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
