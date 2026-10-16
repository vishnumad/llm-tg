import type { ModelMessage, ToolResultPart } from "ai";

export const MAX_TOOL_CHARS = 2_000;

type ContentPart = Exclude<ModelMessage["content"], string>[number];

export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}... [truncated]`;
}

function renderToolOutput(output: ToolResultPart["output"]): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
    case "content":
      return JSON.stringify(output.value);
    case "execution-denied":
      return "[execution denied]";
  }
}

function renderPart(part: ContentPart): string | undefined {
  switch (part.type) {
    case "text":
      return part.text;
    case "image":
      return "[image]";
    case "file":
      return part.mediaType.startsWith("image/")
        ? "[image]"
        : `[file: ${part.mediaType}]`;
    case "tool-call":
      return `[tool call: ${part.toolName}(${truncate(JSON.stringify(part.input), MAX_TOOL_CHARS)})]`;
    case "tool-result":
      return `[tool result: ${part.toolName} -> ${truncate(renderToolOutput(part.output), MAX_TOOL_CHARS)}]`;
    default:
      return undefined;
  }
}

function renderMessage(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  const parts: ContentPart[] = message.content;
  return parts.flatMap((part) => renderPart(part) ?? []).join("\n");
}

/**
 * Flatten a history into plain text for the summariser. Images and files
 * become placeholders, since text-only models reject them outright.
 */
export function renderTranscript(history: ModelMessage[]): string {
  return history
    .flatMap((message) => {
      const body = renderMessage(message).trim();
      return body ? [`${message.role}: ${body}`] : [];
    })
    .join("\n\n");
}
