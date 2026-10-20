import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
import type { SearchProvider } from "./provider";

const SYSTEM_PROMPT = [
  "You are a web search assistant. Find relevant information based on the user's query.",
  "When provided a URL, fetch it and complete the requested task or provide a summary if no task is provided.",
  "Provide concise and accurate responses conveying only the necessary information.",
].join("\n");

export function createGeminiProvider(
  apiKey: string,
  modelId: string,
): SearchProvider {
  const google = createGoogleGenerativeAI({ apiKey });
  const model = google(modelId);

  return {
    name: "gemini",

    async search(query) {
      const { text, sources } = await generateText({
        model,
        system: SYSTEM_PROMPT,
        prompt: query,
        tools: { google_search: google.tools.googleSearch({}) },
      });

      return {
        answer: text,
        results: sources.flatMap((source) =>
          source.sourceType === "url"
            ? [
                {
                  title: source.title ?? source.url,
                  url: source.url,
                  content: "",
                },
              ]
            : [],
        ),
      };
    },

    async read(urls, question) {
      const { text } = await generateText({
        model,
        system: SYSTEM_PROMPT,
        prompt: [...urls, question ?? "Summarize these pages."].join("\n"),
        tools: { url_context: google.tools.urlContext({}) },
      });

      return { answer: text, pages: [], failed: [] };
    },
  };
}
