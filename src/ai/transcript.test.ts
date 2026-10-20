import { expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { renderTranscript } from "./transcript";

test("renders each message as role and text, separated by blank lines", () => {
  const history: ModelMessage[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "hi there" }] },
  ];
  expect(renderTranscript(history)).toBe("user: hello\n\nassistant: hi there");
});

test("replaces images and files with placeholders", () => {
  const history: ModelMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "file", data: "aGk=", mediaType: "image/jpeg" },
        { type: "file", data: "aGk=", mediaType: "application/pdf" },
      ],
    },
  ];
  expect(renderTranscript(history)).toBe(
    "user: look\n[image]\n[file: application/pdf]",
  );
});

test("renders tool calls and their results", () => {
  const history: ModelMessage[] = [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "1",
          toolName: "webSearch",
          input: { query: "bun" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "1",
          toolName: "webSearch",
          output: { type: "text", value: "Bun is a runtime" },
        },
      ],
    },
  ];
  expect(renderTranscript(history)).toBe(
    'assistant: [tool call: webSearch({"query":"bun"})]\n\ntool: [tool result: webSearch -> Bun is a runtime]',
  );
});

test("truncates long tool results", () => {
  const history: ModelMessage[] = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "1",
          toolName: "webSearch",
          output: { type: "text", value: "x".repeat(5_000) },
        },
      ],
    },
  ];
  expect(renderTranscript(history)).toBe(
    `tool: [tool result: webSearch -> ${"x".repeat(2_000)}... [truncated]]`,
  );
});

test("skips messages with nothing to render", () => {
  const history: ModelMessage[] = [
    { role: "assistant", content: [{ type: "reasoning", text: "hmm" }] },
    { role: "user", content: "hello" },
  ];
  expect(renderTranscript(history)).toBe("user: hello");
});
