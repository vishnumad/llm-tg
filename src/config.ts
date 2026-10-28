import { z } from "zod";

const schema = z.object({
  TELEGRAM_API_KEY: z.string(),
  SEARCH_PROVIDER: z.enum(["tavily", "gemini"]).default("tavily"),
  IMAGE_PROVIDER: z.enum(["perchance"]).optional(),
  AUTO_COMPACT_TOKEN_THRESHOLD: z.coerce.number().int().positive().optional(),
  CHAT_DATA_DIR: z.string().default("./data/chats"),
  MODEL_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  DEBUG_LOGGING: z.stringbool().default(false),
});

const groq = z
  .object({
    GROQ_API_KEY: z.string(),
    GROQ_DEFAULT_MODEL_ID: z.string(),
  })
  .transform((env) => ({
    chatModel: {
      provider: "groq" as const,
      apiKey: env.GROQ_API_KEY,
      modelId: env.GROQ_DEFAULT_MODEL_ID,
    },
  }));

const openAICompatible = z
  .object({
    OPENAI_COMPATIBLE_BASE_URL: z.url({ protocol: /^https?$/ }),
    OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
    OPENAI_COMPATIBLE_MODEL_ID: z.string(),
  })
  .transform((env) => ({
    chatModel: {
      provider: "openai-compatible" as const,
      baseURL: env.OPENAI_COMPATIBLE_BASE_URL,
      apiKey: env.OPENAI_COMPATIBLE_API_KEY,
      modelId: env.OPENAI_COMPATIBLE_MODEL_ID,
    },
  }));

const tavily = z.object({ TAVILY_API_KEY: z.string() }).transform((env) => ({
  search: { provider: "tavily" as const, apiKey: env.TAVILY_API_KEY },
}));

const gemini = z
  .object({
    GEMINI_API_KEY: z.string(),
    WEB_SEARCH_MODEL_ID: z.string(),
  })
  .transform((env) => ({
    search: {
      provider: "gemini" as const,
      apiKey: env.GEMINI_API_KEY,
      modelId: env.WEB_SEARCH_MODEL_ID,
    },
  }));

const perchance = z
  .object({ PERCHANCE_CHROMIUM_PATH: z.string().optional() })
  .transform((env) => ({
    image: {
      provider: "perchance" as const,
      executablePath: env.PERCHANCE_CHROMIUM_PATH,
    },
  }));

const noImages = z.object({}).transform(() => ({ image: undefined }));

export function parseConfig(processEnv: Record<string, string | undefined>) {
  // Blank values count as unset, so `KEY=` in a .env file falls back to the default.
  const env = Object.fromEntries(
    Object.entries(processEnv).filter(([, value]) => value?.trim()),
  );

  const chatProvider = env.OPENAI_COMPATIBLE_BASE_URL ? openAICompatible : groq;
  const searchProvider = env.SEARCH_PROVIDER === "gemini" ? gemini : tavily;
  const imageProvider =
    env.IMAGE_PROVIDER === "perchance" ? perchance : noImages;
  const parsed = schema
    .and(chatProvider)
    .and(searchProvider)
    .and(imageProvider)
    .safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment variables:\n${z.prettifyError(parsed.error)}`,
    );
  }

  return parsed.data;
}

export const config = parseConfig(process.env);
