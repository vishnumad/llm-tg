import { beforeEach, describe, expect, test } from "bun:test";
import { generateText } from "../../test-setup";
import { createGeminiProvider } from "./gemini";

beforeEach(() => generateText.mockReset());

describe("createGeminiProvider", () => {
  test("returns Gemini's answer with its URL sources", async () => {
    generateText.mockResolvedValueOnce({
      text: "Bun is a runtime.",
      sources: [
        {
          type: "source",
          sourceType: "url",
          id: "1",
          url: "https://bun.sh",
          title: "Bun",
        },
        {
          type: "source",
          sourceType: "document",
          id: "2",
          mediaType: "application/pdf",
          title: "A PDF",
        },
      ],
    });

    const response = await createGeminiProvider("key", "model").search("bun");

    expect(response).toEqual({
      answer: "Bun is a runtime.",
      results: [{ title: "Bun", url: "https://bun.sh", content: "" }],
    });
  });

  test("reads pages by asking Gemini about the URLs", async () => {
    generateText.mockResolvedValueOnce({
      text: "It's a runtime.",
      sources: [],
    });

    const response = await createGeminiProvider("key", "model").read(
      ["https://bun.sh"],
      "what is it?",
    );

    expect(generateText.mock.calls[0]?.[0].prompt).toBe(
      "https://bun.sh\nwhat is it?",
    );
    expect(response).toEqual({
      answer: "It's a runtime.",
      pages: [],
      failed: [],
    });
  });
});
