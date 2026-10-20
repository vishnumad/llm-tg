import { beforeEach, describe, expect, test } from "bun:test";
import { tavily, tavilyExtract, tavilySearch } from "../../test-setup";
import { createTavilyProvider } from "./tavily";

beforeEach(() => {
  tavilySearch.mockReset();
  tavilyExtract.mockReset();
});

describe("createTavilyProvider", () => {
  test("passes the API key explicitly, so the SDK never runs keyless", () => {
    createTavilyProvider("tavily-key");

    expect(tavily).toHaveBeenLastCalledWith({ apiKey: "tavily-key" });
  });

  test("searches with the cheapest settings and maps the results", async () => {
    tavilySearch.mockResolvedValueOnce({
      results: [
        {
          title: "Bun",
          url: "https://bun.sh",
          content: "A fast runtime",
          publishedDate: "",
          score: 0.9,
          id: "1",
        },
        {
          title: "News",
          url: "https://news.example",
          content: "Bun 2 is out",
          publishedDate: "2026-10-01",
          score: 0.8,
          id: "2",
        },
      ],
      usage: { credits: 1 },
    });

    const response = await createTavilyProvider("key").search("bun", {
      topic: "news",
      timeRange: "week",
    });

    expect(tavilySearch).toHaveBeenCalledWith("bun", {
      searchDepth: "basic",
      maxResults: 5,
      topic: "news",
      timeRange: "week",
      includeUsage: true,
    });
    expect(response).toEqual({
      results: [
        {
          title: "Bun",
          url: "https://bun.sh",
          content: "A fast runtime",
          publishedDate: undefined,
        },
        {
          title: "News",
          url: "https://news.example",
          content: "Bun 2 is out",
          publishedDate: "2026-10-01",
        },
      ],
    });
  });

  test("reads pages with a basic extract and reports failures", async () => {
    tavilyExtract.mockResolvedValueOnce({
      results: [{ url: "https://bun.sh", title: null, rawContent: "# Bun" }],
      failedResults: [{ url: "https://down.example", error: "timeout" }],
      usage: { credits: 1 },
    });

    const response = await createTavilyProvider("key").read(
      ["https://bun.sh", "https://down.example"],
      "what is it?",
    );

    expect(tavilyExtract).toHaveBeenCalledWith(
      ["https://bun.sh", "https://down.example"],
      {
        extractDepth: "basic",
        format: "markdown",
        query: "what is it?",
        includeUsage: true,
      },
    );
    expect(response).toEqual({
      pages: [{ url: "https://bun.sh", title: undefined, content: "# Bun" }],
      failed: [{ url: "https://down.example", error: "timeout" }],
    });
  });
});
