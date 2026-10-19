import { describe, expect, test } from "bun:test";
import { parseConfig } from "./config";

const base = {
  TELEGRAM_API_KEY: "telegram",
  GEMINI_API_KEY: "gemini",
  WEB_SEARCH_MODEL_ID: "search-model",
};

const groq = {
  GROQ_API_KEY: "groq-key",
  GROQ_DEFAULT_MODEL_ID: "qwen/qwen3-32b",
};

describe("parseConfig", () => {
  test("uses Groq by default", () => {
    expect(parseConfig({ ...base, ...groq }).chatModel).toEqual({
      provider: "groq",
      apiKey: "groq-key",
      modelId: "qwen/qwen3-32b",
    });
  });

  test("uses an OpenAI-compatible API, even over Groq, once its base URL is set", () => {
    const { chatModel } = parseConfig({
      ...base,
      ...groq,
      OPENAI_COMPATIBLE_BASE_URL: "http://localhost:11434/v1",
      OPENAI_COMPATIBLE_MODEL_ID: "llama3.2",
    });

    expect(chatModel).toEqual({
      provider: "openai-compatible",
      baseURL: "http://localhost:11434/v1",
      apiKey: undefined,
      modelId: "llama3.2",
    });
  });

  test("reports every missing or invalid variable at once", () => {
    expect(() =>
      parseConfig({
        GEMINI_API_KEY: "gemini",
        WEB_SEARCH_MODEL_ID: "search-model",
        OPENAI_COMPATIBLE_BASE_URL: "localhost:11434/v1",
      }),
    ).toThrow(
      /TELEGRAM_API_KEY.*OPENAI_COMPATIBLE_BASE_URL.*OPENAI_COMPATIBLE_MODEL_ID/s,
    );
  });
});
