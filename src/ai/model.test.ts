import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createChatModel } from "./model";

afterEach(() => mock.restore());

describe("createChatModel", () => {
  test("builds a Groq model", () => {
    const model = createChatModel({
      provider: "groq",
      apiKey: "groq-key",
      modelId: "qwen/qwen3-32b",
    });

    expect(model.provider).toBe("groq.chat");
    expect(model.modelId).toBe("qwen/qwen3-32b");
  });

  test("sends an OpenAI-compatible model's requests to its base URL", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        choices: [{ message: { content: "Hi!" }, finish_reason: "stop" }],
      }),
    );
    const model = createChatModel({
      provider: "openai-compatible",
      baseURL: "https://llm.example.com/v1",
      apiKey: "secret",
      modelId: "llama3.2",
    });

    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer secret",
    );
    expect(JSON.parse(String(init?.body)).model).toBe("llama3.2");
  });
});
