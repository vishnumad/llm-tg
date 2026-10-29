import { describe, expect, test } from "bun:test";
import { parseConfig } from "./config";

const base = {
  TELEGRAM_API_KEY: "telegram",
  TAVILY_API_KEY: "tavily-key",
};

const gemini = {
  GEMINI_API_KEY: "gemini-key",
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
        TAVILY_API_KEY: "tavily-key",
        OPENAI_COMPATIBLE_BASE_URL: "localhost:11434/v1",
      }),
    ).toThrow(
      /TELEGRAM_API_KEY.*OPENAI_COMPATIBLE_BASE_URL.*OPENAI_COMPATIBLE_MODEL_ID/s,
    );
  });

  test("has no model timeout and no debug logging by default", () => {
    const config = parseConfig({ ...base, ...groq });

    expect(config.MODEL_TIMEOUT_MS).toBeUndefined();
    expect(config.DEBUG_LOGGING).toBe(false);
  });

  test("reads the model timeout and debug logging switch", () => {
    const config = parseConfig({
      ...base,
      ...groq,
      MODEL_TIMEOUT_MS: "300000",
      DEBUG_LOGGING: "true",
    });

    expect(config.MODEL_TIMEOUT_MS).toBe(300_000);
    expect(config.DEBUG_LOGGING).toBe(true);
  });

  test("rejects a debug logging value that isn't a boolean", () => {
    expect(() =>
      parseConfig({ ...base, ...groq, DEBUG_LOGGING: "maybe" }),
    ).toThrow(/DEBUG_LOGGING/);
  });

  test("searches with Tavily by default", () => {
    expect(parseConfig({ ...base, ...groq }).search).toEqual({
      provider: "tavily",
      apiKey: "tavily-key",
    });
  });

  test("needs a Tavily key for Tavily, but no Gemini settings", () => {
    const { TAVILY_API_KEY: _, ...withoutKey } = base;
    expect(() => parseConfig({ ...withoutKey, ...groq })).toThrow(
      /TAVILY_API_KEY/,
    );
  });

  test("searches with Gemini once selected, without a Tavily key", () => {
    const { TAVILY_API_KEY: _, ...withoutKey } = base;
    const { search } = parseConfig({
      ...withoutKey,
      ...groq,
      ...gemini,
      SEARCH_PROVIDER: "gemini",
    });

    expect(search).toEqual({
      provider: "gemini",
      apiKey: "gemini-key",
      modelId: "search-model",
    });
  });

  test("needs the Gemini settings for Gemini", () => {
    expect(() =>
      parseConfig({ ...base, ...groq, SEARCH_PROVIDER: "gemini" }),
    ).toThrow(/GEMINI_API_KEY.*WEB_SEARCH_MODEL_ID/s);
  });

  test("rejects an unknown search provider", () => {
    expect(() =>
      parseConfig({ ...base, ...groq, SEARCH_PROVIDER: "bing" }),
    ).toThrow(/SEARCH_PROVIDER/);
  });
});
