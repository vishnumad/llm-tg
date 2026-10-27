import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { config } from "../config";
import { logger } from "../logger";

/**
 * Logs each HTTP call to the model provider, so its retries, status codes and
 * latency are visible - the SDK otherwise only surfaces the final outcome.
 */
async function logFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  const startedAt = performance.now();
  const durationMs = () => Math.round(performance.now() - startedAt);
  logger.debug("model.request_sent", { url });
  try {
    const response = await fetch(input, init);
    logger.debug("model.response_received", {
      url,
      status: response.status,
      durationMs: durationMs(),
    });
    return response;
  } catch (error) {
    logger.error("model.request_failed", error, {
      url,
      durationMs: durationMs(),
    });
    throw error;
  }
}

// Bun's fetch type also carries `preconnect`.
const loggedFetch = Object.assign(logFetch, { preconnect: fetch.preconnect });

export function createChatModel(settings: typeof config.chatModel) {
  switch (settings.provider) {
    case "groq":
      return createGroq({ apiKey: settings.apiKey, fetch: loggedFetch })(
        settings.modelId,
      );
    case "openai-compatible":
      return createOpenAICompatible({
        name: "openai-compatible",
        baseURL: settings.baseURL,
        apiKey: settings.apiKey,
        fetch: loggedFetch,
      })(settings.modelId);
  }
}

export const model = createChatModel(config.chatModel);
