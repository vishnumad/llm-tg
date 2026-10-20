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

/** Stands in for every model call, so no test can reach a real provider. */
export const generateText = mock();
mock.module("ai", () => ({ ...ai, generateText }));

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
