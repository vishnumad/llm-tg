import { config } from "../../config";
import { createGeminiProvider } from "./gemini";
import type { SearchProvider } from "./provider";
import { createTavilyProvider } from "./tavily";
import { createSearchTools } from "./tools";

export function createSearchProvider(
  settings: typeof config.search,
): SearchProvider {
  switch (settings.provider) {
    case "tavily":
      return createTavilyProvider(settings.apiKey);
    case "gemini":
      return createGeminiProvider(settings.apiKey, settings.modelId);
  }
}

export const searchTools = createSearchTools(
  createSearchProvider(config.search),
);
