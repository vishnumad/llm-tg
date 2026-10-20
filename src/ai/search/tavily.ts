import { tavily } from "@tavily/core";
import { logger } from "../../logger";
import type { SearchProvider } from "./provider";

export function createTavilyProvider(apiKey: string): SearchProvider {
  // The key must be passed explicitly: without one the SDK quietly falls back
  // to a shared, rate-limited keyless mode.
  const client = tavily({ apiKey });

  return {
    name: "tavily",

    async search(query, { topic, timeRange } = {}) {
      // Basic depth is the cheapest search: 1 credit.
      const response = await client.search(query, {
        searchDepth: "basic",
        maxResults: 5,
        topic,
        timeRange,
        includeUsage: true,
      });
      logger.info("tavily.search", { credits: response.usage?.credits });

      return {
        results: response.results.map((result) => ({
          title: result.title,
          url: result.url,
          content: result.content,
          publishedDate: result.publishedDate || undefined,
        })),
      };
    },

    async read(urls, question) {
      // Basic depth is the cheapest extract: 1 credit per 5 pages read.
      const response = await client.extract(urls, {
        extractDepth: "basic",
        format: "markdown",
        query: question,
        includeUsage: true,
      });
      logger.info("tavily.extract", { credits: response.usage?.credits });

      return {
        pages: response.results.map((page) => ({
          url: page.url,
          title: page.title ?? undefined,
          content: page.rawContent,
        })),
        failed: response.failedResults,
      };
    },
  };
}
