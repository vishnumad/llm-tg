import { tool } from "ai";
import { z } from "zod";
import { logToolCall } from "../tool-logging";
import { truncate } from "../transcript";
import type { ReadResponse, SearchProvider, SearchResponse } from "./provider";

export const MAX_PAGE_CHARS = 8_000;
export const MAX_URLS = 3;

export function formatSearchResponse({ answer, results }: SearchResponse) {
  const entries = results.map((result, index) => {
    const date = result.publishedDate ? ` (${result.publishedDate})` : "";
    const heading = `${index + 1}. ${result.title} - ${result.url}${date}`;
    return result.content ? `${heading}\n${result.content}` : heading;
  });
  return (
    [answer, ...entries].filter(Boolean).join("\n\n") || "No results found."
  );
}

export function formatReadResponse({ answer, pages, failed }: ReadResponse) {
  const sections = [
    answer,
    ...pages.map((page) => {
      const heading = page.title ? `${page.title} - ${page.url}` : page.url;
      return `${heading}\n${truncate(page.content, MAX_PAGE_CHARS)}`;
    }),
    ...failed.map((page) => `Could not read ${page.url}: ${page.error}`),
  ].filter(Boolean);
  return sections.join("\n\n") || "Nothing could be read from those pages.";
}

export function createSearchTools(provider: SearchProvider) {
  return {
    webSearch: tool({
      description:
        "Search the web for current events or facts you don't know. Write one precise query; use topic 'news' and timeRange for recent events. Returns ranked results with snippets.",
      inputSchema: z.object({
        query: z.string().describe("A concise search query."),
        topic: z
          .enum(["general", "news"])
          .optional()
          .describe("Use 'news' for current events."),
        timeRange: z
          .enum(["day", "week", "month", "year"])
          .optional()
          .describe("Only return results from this recent period."),
      }),
      execute: ({ query, topic, timeRange }) =>
        logToolCall(
          "web_search",
          { provider: provider.name, query, topic, timeRange },
          async () =>
            formatSearchResponse(
              await provider.search(query, { topic, timeRange }),
            ),
        ),
    }),

    readWebPage: tool({
      description:
        "Read the content of specific web pages, such as a link the user shared or a promising search result.",
      inputSchema: z.object({
        urls: z
          .array(z.url())
          .min(1)
          .max(MAX_URLS)
          .describe(`Up to ${MAX_URLS} page URLs.`),
        question: z
          .string()
          .optional()
          .describe("What to look for on the pages, if anything specific."),
      }),
      execute: ({ urls, question }) =>
        logToolCall(
          "read_web_page",
          { provider: provider.name, urls, question },
          async () => formatReadResponse(await provider.read(urls, question)),
        ),
    }),
  };
}
