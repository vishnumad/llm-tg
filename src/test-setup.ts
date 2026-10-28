import { afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ai from "ai";

const dataDir = mkdtempSync(join(tmpdir(), "llm-tg-test-"));

// Fixed values, so tests never depend on a developer's .env.
Object.assign(process.env, {
  TELEGRAM_API_KEY: "test",
  GROQ_API_KEY: "test",
  SEARCH_PROVIDER: "",
  TAVILY_API_KEY: "test",
  GEMINI_API_KEY: "test",
  GROQ_DEFAULT_MODEL_ID: "default-model",
  OPENAI_COMPATIBLE_BASE_URL: "",
  WEB_SEARCH_MODEL_ID: "search-model",
  AUTO_COMPACT_TOKEN_THRESHOLD: "1000",
  CHAT_DATA_DIR: dataDir,
});

/** Stand in for every model call, so no test can reach a real provider. */
export const generateText = mock();
export const streamText = mock();
mock.module("ai", () => ({ ...ai, generateText, streamText }));

type Usage = { inputTokens?: number; outputTokens?: number };

export type FakeStream = {
  /** Text deltas for each model step. The last step's text is the answer. */
  steps?: string[][];
  response?: { messages: unknown[] };
  usage?: Usage;
  totalUsage?: Usage;
  /** Emitted as an error part once the deltas are out. */
  error?: unknown;
  /** Waited on once the deltas are out, e.g. for the user to press stop. */
  gate?: Promise<unknown>;
};

/**
 * A `streamText` implementation that plays back the given steps. It ends with
 * an abort part if the call's `abortSignal` fired by the time `gate` settles.
 */
export function fakeStream({
  steps = [["Hi!"]],
  response,
  usage = { inputTokens: 10, outputTokens: 10 },
  totalUsage = usage,
  error,
  gate,
}: FakeStream = {}) {
  return ({ abortSignal }: { abortSignal?: AbortSignal }) => {
    const text = (steps.at(-1) ?? []).join("");
    async function* fullStream() {
      for (const deltas of steps) {
        yield { type: "start-step" };
        for (const delta of deltas) {
          yield { type: "text-delta", text: delta };
        }
        yield { type: "finish-step" };
      }
      await gate;
      if (abortSignal?.aborted) {
        yield { type: "abort" };
        return;
      }
      if (error !== undefined) {
        yield { type: "error", error };
      }
    }
    return {
      fullStream: fullStream(),
      text: Promise.resolve(text),
      response: Promise.resolve(
        response ?? { messages: [{ role: "assistant", content: text }] },
      ),
      usage: Promise.resolve(usage),
      totalUsage: Promise.resolve(totalUsage),
    };
  };
}

/** Stands in for the Tavily client, so no test can spend search credits. */
export const tavilySearch = mock();
export const tavilyExtract = mock();
export const tavily = mock(() => ({
  search: tavilySearch,
  extract: tavilyExtract,
}));
mock.module("@tavily/core", () => ({ tavily }));

let lastChatId = 0;

/** A chat id no other test has used, since chat state is shared per process. */
export function uniqueChatId(): number {
  lastChatId += 1;
  return lastChatId;
}

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
