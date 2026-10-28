# llm-tg

Telegram bot for chatting with an LLM.

## Setup

```sh
bun install
cp .env.sample .env   # fill in the keys
bun run dev           # or `bun run start`
```

| Variable | |
| --- | --- |
| `TELEGRAM_API_KEY` | Bot token |
| `GROQ_API_KEY` | Chat model key, for Groq |
| `GROQ_DEFAULT_MODEL_ID` | e.g. `qwen/qwen3-32b` |
| `OPENAI_COMPATIBLE_BASE_URL` | e.g. `https://openrouter.ai/api/v1`, or `http://localhost:11434/v1` for Ollama |
| `OPENAI_COMPATIBLE_API_KEY` | Optional, for servers that take no key |
| `OPENAI_COMPATIBLE_MODEL_ID` | e.g. `meta-llama/llama-3.3-70b-instruct` |
| `SEARCH_PROVIDER` | Optional. `tavily` (default) or `gemini` |
| `TAVILY_API_KEY` | Web search key, for Tavily |
| `GEMINI_API_KEY` | Web search key, only when `SEARCH_PROVIDER=gemini` |
| `WEB_SEARCH_MODEL_ID` | Only when `SEARCH_PROVIDER=gemini`, e.g. `gemini-2.5-flash-lite` |
| `IMAGE_PROVIDER` | Optional. `perchance` to let the chat model make images |
| `PERCHANCE_CHROMIUM_PATH` | Optional. Chromium binary for Perchance; the Docker image sets it |
| `AUTO_COMPACT_TOKEN_THRESHOLD` | Optional. Summarize history once context exceeds this, e.g. `60000` |
| `CHAT_DATA_DIR` | Optional. Defaults to `./data/chats` |
| `MODEL_TIMEOUT_MS` | Optional. Abandon a chat model call after this long, e.g. `300000`. No timeout by default |
| `DEBUG_LOGGING` | Optional. `true` to log each model request and step |

The chat model comes from Groq, or from an OpenAI-compatible API once `OPENAI_COMPATIBLE_BASE_URL` is set. It has to support tool calling, which web search runs through.

Web search gives the chat model two tools: `webSearch` and `readWebPage`. Each backend lives in `src/ai/search/` and implements the `SearchProvider` interface in `provider.ts`; to add one (e.g. Exa), write a provider file, add its config branch in `src/config.ts`, and add a case in `src/ai/search/index.ts`.

Image generation gives the chat model a `generateImage` tool, which sends the image to the chat. Guest-mode replies can't carry photos, so they don't get it. Backends live in `src/ai/image/` and implement the `ImageProvider` interface in `provider.ts`; adding one works like adding a search backend.

Perchance has no API, so its provider drives a headless Chromium through the endpoints of Perchance's own pages, one image at a time. This is unofficial and can break whenever Perchance changes its site. Perchance doesn't want its ad-funded generators used from servers, so use it at your own risk. Outside Docker, install a browser with `bunx playwright-core install chromium`.

Checks: `bun test`, `bun run typecheck`, `bun run lint` (`bun run format` to fix).

## Docker

```sh
docker compose up -d --build
```

Compose reads `.env` at runtime and keeps chat history in the `chats` volume. Run only one instance per bot token.

## Usage

The bot replies to `/g <message>` (also as a photo caption), `@mentions`, and replies to its own messages.

- `/newchat` - clear history
- `/compact` - summarize history to save tokens
- `/whichmodel`, `/debug`, `/chatinfo`, `/ping` - info

## BotFather settings

- **Guest Mode** (Bot Settings -> Guest Mode) lets it answer `@mentions` in chats it isn't in. Note: The bot can only reply once per message and long answers get truncated.
- **Access** (Bot Settings -> Access -> Restrict bot usage) controls who can use it. The bot has no built in allowlist.
