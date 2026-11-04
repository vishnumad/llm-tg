# llm-tg

Telegram bot for chatting with an LLM.

## Setup

```sh
bun install
cp .env.sample .env   # fill in the keys
bun run start
```

Or with Docker:

```sh
docker compose up -d --build
```

Chat history is kept in the `chats` volume. Run only one instance per bot token.

## Configuration

| Variable | |
| --- | --- |
| `TELEGRAM_API_KEY` | Bot token from BotFather |

**Chat model.** Use Groq, or any OpenAI-compatible API once `OPENAI_COMPATIBLE_BASE_URL` is set. The model must support tool calling.

| Variable | |
| --- | --- |
| `GROQ_API_KEY` | Groq API key |
| `GROQ_DEFAULT_MODEL_ID` | e.g. `qwen/qwen3-32b` |
| `OPENAI_COMPATIBLE_BASE_URL` | e.g. `https://openrouter.ai/api/v1`, or `http://localhost:11434/v1` for Ollama |
| `OPENAI_COMPATIBLE_API_KEY` | Optional, for servers that take no key |
| `OPENAI_COMPATIBLE_MODEL_ID` | e.g. `meta-llama/llama-3.3-70b-instruct` |

**Web search.**

| Variable | |
| --- | --- |
| `SEARCH_PROVIDER` | Optional. `tavily` (default) or `gemini` |
| `TAVILY_API_KEY` | Tavily API key |
| `GEMINI_API_KEY` | Only when `SEARCH_PROVIDER=gemini` |
| `WEB_SEARCH_MODEL_ID` | Only when `SEARCH_PROVIDER=gemini`, e.g. `gemini-2.5-flash-lite` |

**Images (optional).** Lets the bot make and edit images through Cloudflare Workers AI. The free tier covers about 95 images a day.

| Variable | |
| --- | --- |
| `IMAGE_PROVIDER` | `cloudflare` to turn images on |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | Make one from the "Workers AI" template |
| `CLOUDFLARE_IMAGE_MODEL_ID` | Optional. Any FLUX.2 model, defaults to `@cf/black-forest-labs/flux-2-klein-4b` |
| `TELEGRAM_UPLOAD_CHAT_ID` | Optional. Needed for images in guest-mode replies. A private channel where the bot is an admin, or your own chat with it |

**Other.**

| Variable | |
| --- | --- |
| `AUTO_COMPACT_TOKEN_THRESHOLD` | Optional. Summarize history once context exceeds this, e.g. `60000` |
| `CHAT_DATA_DIR` | Optional. Defaults to `./data/chats` |
| `MODEL_TIMEOUT_MS` | Optional. Give up on a model call after this long, e.g. `300000` |
| `DEBUG_LOGGING` | Optional. `true` to log each model request |

## Usage

The bot replies to `/g <message>` (also as a photo caption), `@mentions`, and replies to its own messages. With images on, send a photo or reply to one and ask for changes.

- `/newchat` - clear history
- `/compact` - summarize history to save tokens
- `/whichmodel`, `/debug`, `/chatinfo`, `/ping` - info

## BotFather settings

- **Guest Mode** (Bot Settings -> Guest Mode) lets it answer `@mentions` in chats it isn't in. The bot can only reply once per message, and long answers get cut short.
- **Access** (Bot Settings -> Access -> Restrict bot usage) controls who can use it. The bot has no built-in allowlist.
