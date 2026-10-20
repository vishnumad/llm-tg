import { describe, expect, mock, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import type { SearchProvider } from "./provider";
import {
  createSearchTools,
  formatReadResponse,
  formatSearchResponse,
  MAX_PAGE_CHARS,
} from "./tools";

const options = { toolCallId: "1", messages: [] } as ToolExecutionOptions;

function fakeProvider(overrides: Partial<SearchProvider> = {}): SearchProvider {
  return {
    name: "fake",
    search: mock(async () => ({ results: [] })),
    read: mock(async () => ({ pages: [], failed: [] })),
    ...overrides,
  };
}

describe("formatSearchResponse", () => {
  test("numbers results with their date and snippet", () => {
    expect(
      formatSearchResponse({
        results: [
          {
            title: "Bun",
            url: "https://bun.sh",
            content: "A fast runtime",
            publishedDate: "2026-10-01",
          },
          { title: "Docs", url: "https://bun.sh/docs", content: "" },
        ],
      }),
    ).toBe(
      "1. Bun - https://bun.sh (2026-10-01)\nA fast runtime\n\n2. Docs - https://bun.sh/docs",
    );
  });

  test("puts a written answer before the results", () => {
    expect(
      formatSearchResponse({
        answer: "Bun is a runtime.",
        results: [{ title: "Bun", url: "https://bun.sh", content: "" }],
      }),
    ).toBe("Bun is a runtime.\n\n1. Bun - https://bun.sh");
  });

  test("says so when nothing was found", () => {
    expect(formatSearchResponse({ results: [] })).toBe("No results found.");
  });
});

describe("formatReadResponse", () => {
  test("caps each page and lists pages that failed", () => {
    const text = formatReadResponse({
      pages: [
        {
          url: "https://bun.sh",
          title: "Bun",
          content: "x".repeat(MAX_PAGE_CHARS + 10),
        },
      ],
      failed: [{ url: "https://down.example", error: "timeout" }],
    });

    expect(text).toBe(
      `Bun - https://bun.sh\n${"x".repeat(MAX_PAGE_CHARS)}... [truncated]\n\nCould not read https://down.example: timeout`,
    );
  });
});

describe("createSearchTools", () => {
  test("webSearch passes the query and filters to the provider", async () => {
    const provider = fakeProvider();
    const { webSearch } = createSearchTools(provider);

    await webSearch.execute?.(
      { query: "bun", topic: "news", timeRange: "day" },
      options,
    );

    expect(provider.search).toHaveBeenCalledWith("bun", {
      topic: "news",
      timeRange: "day",
    });
  });

  test("readWebPage accepts at most three URLs", () => {
    const { readWebPage } = createSearchTools(fakeProvider());
    const schema = readWebPage.inputSchema as {
      safeParse(value: unknown): { success: boolean };
    };
    const urls = (count: number) =>
      Array.from({ length: count }, (_, i) => `https://example.com/${i}`);

    expect(schema.safeParse({ urls: urls(3) }).success).toBe(true);
    expect(schema.safeParse({ urls: urls(4) }).success).toBe(false);
    expect(schema.safeParse({ urls: ["not a url"] }).success).toBe(false);
  });

  test("rethrows provider errors so the model sees them", async () => {
    const { webSearch } = createSearchTools(
      fakeProvider({
        search: async () => {
          throw new Error("out of credits");
        },
      }),
    );

    await expect(
      webSearch.execute?.({ query: "bun" }, options),
    ).rejects.toThrow("out of credits");
  });
});
