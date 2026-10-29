import {
  type AssistantModelMessage,
  type FilePart,
  type ModelMessage,
  stepCountIs,
  streamText,
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

export type ReplyOptions = {
  onText?: (textSoFar: string) => void;
  /** Stops the turn, keeping whatever was written so far. */
  abortSignal?: AbortSignal;
};

export type Reply = { text: string; stopped: boolean };

function keepStoppedAnswer(
  chatId: number,
  userMessage: ModelMessage,
  text: string,
): Reply {
  if (text.trim()) {
    updateChat(chatId, (chat) => {
      chat.history.push(userMessage, { role: "assistant", content: text });
    });
  }
  return { text, stopped: true };
}

export async function generateReply(
  chatId: number,
  { text, context, images }: UserMessage,
  { onText, abortSignal }: ReplyOptions = {},
): Promise<Reply> {
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

  const result = streamText({
    model,
    system: buildSystemPrompt(summary),
    messages: [...history, userMessage],
    tools: searchTools,
    stopWhen: stepCountIs(5),
    timeout: config.MODEL_TIMEOUT_MS,
    abortSignal,
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

  // Only the last step's text is the answer, as text written before a tool
  // call is the model thinking aloud.
  let stepText = "";
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "start-step":
        stepText = "";
        break;
      case "text-delta":
        stepText += part.text;
        onText?.(stepText);
        break;
      case "error":
        throw part.error;
      case "abort":
        // A timeout aborts the stream too, but that's a failure, not a stop.
        if (!abortSignal?.aborted) {
          throw new Error(part.reason ?? "The model call was aborted");
        }
        return keepStoppedAnswer(chatId, userMessage, stepText);
    }
  }

  const answer = await result.text;
  if (!answer.trim()) {
    throw new Error("The model returned an empty answer");
  }

  const [response, usage, totalUsage] = await Promise.all([
    result.response,
    result.usage,
    result.totalUsage,
  ]);
  updateChat(chatId, (chat) => {
    chat.history.push(userMessage, ...trimForHistory(response.messages));
    addUsage(chat, totalUsage);

    // `usage` covers only the final step, whose input is the whole context;
    // `totalUsage` sums every step, so it would overcount.
    const { inputTokens, outputTokens } = usage;
    if (inputTokens !== undefined && outputTokens !== undefined) {
      chat.lastContextTokens = inputTokens + outputTokens;
    }
  });

  return { text: answer, stopped: false };
}
