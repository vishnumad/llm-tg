import { z } from "zod";

const schema = z.object({
  TELEGRAM_API_KEY: z.string(),
  GEMINI_API_KEY: z.string(),
  WEB_SEARCH_MODEL_ID: z.string(),
  AUTO_COMPACT_TOKEN_THRESHOLD: z.coerce.number().int().positive().optional(),
  CHAT_DATA_DIR: z.string().default("./data/chats"),
});

const groq = z
  .object({
    GROQ_API_KEY: z.string(),
    GROQ_DEFAULT_MODEL_ID: z.string(),
  })
  .transform((env) => ({
    provider: "groq" as const,
    apiKey: env.GROQ_API_KEY,
    modelId: env.GROQ_DEFAULT_MODEL_ID,
  }));

const openAICompatible = z
  .object({
    // Plain `z.url()` takes `localhost:11434/v1`, reading `localhost` as the scheme.
    OPENAI_COMPATIBLE_BASE_URL: z.url({ protocol: /^https?$/ }),
    // Optional, since local servers such as Ollama take no key.
    OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
    OPENAI_COMPATIBLE_MODEL_ID: z.string(),
  })
  .transform((env) => ({
    provider: "openai-compatible" as const,
    baseURL: env.OPENAI_COMPATIBLE_BASE_URL,
    apiKey: env.OPENAI_COMPATIBLE_API_KEY,
    modelId: env.OPENAI_COMPATIBLE_MODEL_ID,
  }));

export type ChatModelConfig =
  | z.output<typeof groq>
  | z.output<typeof openAICompatible>;

type Env = Record<string, string | undefined>;

/**
 * The chat model comes from whichever provider is filled in, told apart by
 * the variable each one can't do without. A provider's other settings, like
 * a model id left in from `.env.sample`, don't count.
 */
function chatModelSchema(env: Env) {
  const hasGroq = env.GROQ_API_KEY !== undefined;
  const hasOpenAICompatible = env.OPENAI_COMPATIBLE_BASE_URL !== undefined;
  if (hasGroq && hasOpenAICompatible) {
    return z.never({
      error:
        "GROQ_API_KEY and OPENAI_COMPATIBLE_BASE_URL are both set. Fill in one chat model provider.",
    });
  }
  if (hasGroq) {
    return groq;
  }
  if (hasOpenAICompatible) {
    return openAICompatible;
  }
  return z.never({
    error:
      "No chat model provider. Set GROQ_API_KEY, or OPENAI_COMPATIBLE_BASE_URL for an OpenAI-compatible API.",
  });
}

export function parseConfig(processEnv: Env) {
  // Blank values count as unset, so `KEY=` in a .env file falls back to the default.
  const env = Object.fromEntries(
    Object.entries(processEnv).filter(([, value]) => value?.trim()),
  );

  const chatModel = chatModelSchema(env).transform((settings) => ({
    chatModel: settings,
  }));
  const parsed = schema.and(chatModel).safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment variables:\n${z.prettifyError(parsed.error)}`,
    );
  }

  return parsed.data;
}

export const config = parseConfig(process.env);
