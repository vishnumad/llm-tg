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
| `GROQ_API_KEY` | Chat model key |
| `GEMINI_API_KEY` | Web search key |
| `GROQ_DEFAULT_MODEL_ID` | e.g. `qwen/qwen3-32b` |
| `WEB_SEARCH_MODEL_ID` | e.g. `gemini-2.5-flash-lite` |
| `AUTO_COMPACT_TOKEN_THRESHOLD` | Optional. Summarize history once context exceeds this, e.g. `60000` |
| `CHAT_DATA_DIR` | Optional. Defaults to `./data/chats` |

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
- `/switchmodel <groq-model-id>` / `/switchmodel default` - change this chat's model
- `/whichmodel`, `/debug`, `/chatinfo`, `/ping` - info

## BotFather settings

- **Guest Mode** (Bot Settings -> Guest Mode) lets it answer `@mentions` in chats it isn't in. Note: The bot can only reply once per message and long answers get truncated.
- **Access** (Bot Settings -> Access -> Restrict bot usage) controls who can use it. The bot has no built in allowlist.
