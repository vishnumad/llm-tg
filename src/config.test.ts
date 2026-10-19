import { describe, expect, test } from "bun:test";
import { parseConfig } from "./config";

const base = {
  TELEGRAM_API_KEY: "telegram",
  GEMINI_API_KEY: "gemini",
  WEB_SEARCH_MODEL_ID: "search-model",
};

describe("parseConfig", () => {
  test("uses Groq when GROQ_API_KEY is set", () => {
    const { chatModel } = parseConfig({
      ...base,
      GROQ_API_KEY: "groq-key",
      GROQ_DEFAULT_MODEL_ID: "qwen/qwen3-32b",
    });

    expect(chatModel).toEqual({
      provider: "groq",
      apiKey: "groq-key",
      modelId: "qwen/qwen3-32b",
    });
  });

  test("uses an OpenAI-compatible API when its base URL is set", () => {
    const { chatModel } = parseConfig({
      ...base,
      // As left over from `.env.sample`: a blank key and a model id.
      GROQ_API_KEY: "",
      GROQ_DEFAULT_MODEL_ID: "qwen/qwen3-32b",
      OPENAI_COMPATIBLE_BASE_URL: "http://localhost:11434/v1",
      OPENAI_COMPATIBLE_MODEL_ID: "llama3.2",
    });

    // No API key needed, as for a local server.
    expect(chatModel).toEqual({
      provider: "openai-compatible",
      baseURL: "http://localhost:11434/v1",
      apiKey: undefined,
      modelId: "llama3.2",
    });
  });

  test("reports what the chosen provider is missing", () => {
    expect(() =>
      parseConfig({ ...base, OPENAI_COMPATIBLE_BASE_URL: "localhost:11434" }),
    ).toThrow(
      /Invalid URL\n {2}→ at OPENAI_COMPATIBLE_BASE_URL.*→ at OPENAI_COMPATIBLE_MODEL_ID/s,
    );
  });

  test("rejects two providers at once", () => {
    expect(() =>
      parseConfig({
        ...base,
        GROQ_API_KEY: "groq-key",
        GROQ_DEFAULT_MODEL_ID: "qwen/qwen3-32b",
        OPENAI_COMPATIBLE_BASE_URL: "http://localhost:11434/v1",
        OPENAI_COMPATIBLE_MODEL_ID: "llama3.2",
      }),
    ).toThrow("are both set");
  });

  test("rejects no provider, alongside any other problem", () => {
    expect(() => parseConfig({ GEMINI_API_KEY: "gemini" })).toThrow(
      /No chat model provider.*→ at TELEGRAM_API_KEY/s,
    );
  });
});
