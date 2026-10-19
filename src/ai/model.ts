import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { config } from "../config";

export function createChatModel(settings: typeof config.chatModel) {
  switch (settings.provider) {
    case "groq":
      return createGroq({ apiKey: settings.apiKey })(settings.modelId);
    case "openai-compatible":
      return createOpenAICompatible({
        name: "openai-compatible",
        baseURL: settings.baseURL,
        apiKey: settings.apiKey,
      })(settings.modelId);
  }
}

export const model = createChatModel(config.chatModel);
